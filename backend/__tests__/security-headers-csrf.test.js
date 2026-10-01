import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { closePool } from "../db/pg.js";
import { resetTestDb, seedTestUser, loginAs } from "./setup.js";
import {
  createOriginGuard,
  isSafeMethod,
  isTrustedOrigin,
  normalizeOrigin,
  parseAllowedOrigins,
  PUBLIC_CROSS_ORIGIN_PATHS,
} from "../middleware/security.js";

let app, token;
const SELF_HOST = "crm.example.com";
const SELF_ORIGIN = `https://${SELF_HOST}`;
const EVIL = "https://evil.example.net";

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
});

afterAll(async () => {
  await closePool();
});

// Authenticated state-changing request that would otherwise succeed, so a 403
// can only come from the origin guard and a non-403 proves it let the request
// through to the route.
async function createLead(origin, extra = {}) {
  let req = request(app)
    .post("/api/leads")
    .set("Host", SELF_HOST)
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Origin probe" });
  if (origin !== undefined) req = req.set("Origin", origin);
  return req.set(extra);
}

describe("helmet security headers", () => {
  it("sets clickjacking, sniffing and HSTS headers on responses", async () => {
    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toMatch(/max-age=31536000/);
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
  });

  it("does not advertise the server framework", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("ships a strict Content-Security-Policy without unsafe-eval", async () => {
    const res = await request(app).get("/api/health");
    const csp = res.headers["content-security-policy"];

    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toContain("base-uri 'self'");
    // The previous policy allowed script execution from anywhere.
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("http:");
    expect(csp).not.toContain("https:");
  });
});

describe("Origin validation on state-changing requests", () => {
  it("blocks a cross-origin POST", async () => {
    const res = await createLead(EVIL);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/untrusted origin/i);
  });

  it("blocks a cross-origin POST even when it carries a valid token", async () => {
    const res = await request(app)
      .post("/api/leads")
      .set("Host", SELF_HOST)
      .set("Authorization", `Bearer ${token}`)
      .set("Origin", EVIL)
      .send({ name: "CSRF attempt" });

    expect(res.status).toBe(403);
  });

  it("blocks PUT and DELETE from a foreign origin", async () => {
    const put = await request(app)
      .put("/api/leads/lead_missing")
      .set("Host", SELF_HOST)
      .set("Authorization", `Bearer ${token}`)
      .set("Origin", EVIL)
      .send({ name: "nope" });
    expect(put.status).toBe(403);

    const del = await request(app)
      .delete("/api/leads/lead_missing")
      .set("Host", SELF_HOST)
      .set("Authorization", `Bearer ${token}`)
      .set("Origin", EVIL);
    expect(del.status).toBe(403);
  });

  it("rejects the opaque `null` origin used by sandboxed iframes", async () => {
    const res = await createLead("null");
    expect(res.status).toBe(403);
  });

  it("rejects a foreign Referer when no Origin is sent", async () => {
    const res = await request(app)
      .post("/api/leads")
      .set("Host", SELF_HOST)
      .set("Authorization", `Bearer ${token}`)
      .set("Referer", `${EVIL}/attack.html`)
      .send({ name: "Referer attack" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/untrusted referer/i);
  });

  it("blocks cross-site requests flagged only by Sec-Fetch-Site", async () => {
    const res = await request(app)
      .post("/api/leads")
      .set("Host", SELF_HOST)
      .set("Authorization", `Bearer ${token}`)
      .set("Sec-Fetch-Site", "cross-site")
      .send({ name: "sec-fetch attack" });

    expect(res.status).toBe(403);
  });

  it("allows the request's own origin through to the route", async () => {
    const res = await createLead(SELF_ORIGIN);
    expect(res.status).not.toBe(403);
  });

  it("allows a same-host request whose scheme differs (TLS-terminating proxy)", async () => {
    const res = await createLead(`http://${SELF_HOST}`);
    expect(res.status).not.toBe(403);
  });

  it("allows origins on the ALLOWED_ORIGINS list", async () => {
    const allowed = ["https://app.example.com"];
    const guarded = createOriginGuard({ allowedOrigins: allowed, allowLoopback: false });

    const blocked = await runThrough(guarded, { method: "POST", headers: { origin: EVIL } });
    expect(blocked.status).toBe(403);

    const permitted = await runThrough(guarded, {
      method: "POST",
      headers: { origin: "https://app.example.com" },
    });
    expect(permitted.status).not.toBe(403);
  });

  it("lets safe methods bypass the check entirely", async () => {
    for (const method of ["get", "head", "options"]) {
      const res = await request(app)[method]("/api/health").set("Host", SELF_HOST).set("Origin", EVIL);
      expect(res.status).toBe(200);
    }
  });

  it("allows state-changing requests that send no Origin or Referer", async () => {
    // Non-browser clients (webhooks, curl, native apps) are not CSRF vectors.
    const res = await createLead(undefined);
    expect(res.status).not.toBe(403);
  });

  it("keeps the deliberately cross-origin public endpoints reachable", async () => {
    const hooks = await request(app).post("/api/hooks/unknown-token").set("Origin", EVIL).send({});
    expect(hooks.status).not.toBe(403);

    const submit = await request(app)
      .post("/api/forms/unknown-permalink/submit")
      .set("Origin", EVIL)
      .send({ payload: {} });
    expect(submit.status).not.toBe(403);
  });
});

// Drive a bare middleware with a synthetic req/res to test its decisions
// without needing a matching live route.
function runThrough(middleware, { method = "GET", headers = {}, url = "/api/leads" } = {}) {
  return new Promise((resolve) => {
    const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = {
      method,
      url,
      originalUrl: url,
      protocol: "https",
      get: (name) => lower.get(String(name).toLowerCase()),
    };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
        return this;
      },
    };
    middleware(req, res, () => resolve({ status: 200, body: null, passed: true }));
  });
}

describe("origin guard helpers", () => {
  it("treats only GET/HEAD/OPTIONS as safe", () => {
    expect(isSafeMethod("GET")).toBe(true);
    expect(isSafeMethod("head")).toBe(true);
    expect(isSafeMethod("OPTIONS")).toBe(true);
    expect(isSafeMethod("POST")).toBe(false);
    expect(isSafeMethod("PUT")).toBe(false);
    expect(isSafeMethod("PATCH")).toBe(false);
    expect(isSafeMethod("DELETE")).toBe(false);
  });

  it("normalizes origins and rejects malformed values", () => {
    expect(normalizeOrigin("https://Example.com")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com:443/")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com:8443")).toBe("https://example.com:8443");
    expect(normalizeOrigin("null")).toBeNull();
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
    expect(normalizeOrigin("file:///etc/passwd")).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
  });

  it("parses a comma-separated ALLOWED_ORIGINS list", () => {
    expect(parseAllowedOrigins("https://a.com, https://b.com ,nonsense")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });

  it("matches trusted origins by full origin, hostname and loopback", () => {
    const base = { selfOrigin: SELF_ORIGIN, selfHost: SELF_HOST, allowed: [], allowLoopback: false };

    expect(isTrustedOrigin(SELF_ORIGIN, base)).toBe(true);
    expect(isTrustedOrigin(`http://${SELF_HOST}`, base)).toBe(true);
    expect(isTrustedOrigin(EVIL, base)).toBe(false);
    expect(isTrustedOrigin("null", base)).toBe(false);
    expect(isTrustedOrigin("http://localhost:5173", base)).toBe(false);
    expect(isTrustedOrigin("http://localhost:5173", { ...base, allowLoopback: true })).toBe(true);
    expect(isTrustedOrigin("https://sub.crm.example.com", base)).toBe(false);
  });

  it("lists the cross-origin exemptions it ships with", () => {
    expect(PUBLIC_CROSS_ORIGIN_PATHS.some((p) => p.test("/api/hooks/abc123"))).toBe(true);
    expect(PUBLIC_CROSS_ORIGIN_PATHS.some((p) => p.test("/api/forms/contact/submit"))).toBe(true);
    expect(PUBLIC_CROSS_ORIGIN_PATHS.some((p) => p.test("/api/leads"))).toBe(false);
    expect(PUBLIC_CROSS_ORIGIN_PATHS.some((p) => p.test("/api/auth/login"))).toBe(false);
  });

  it("blocks state-changing requests before the body is parsed", async () => {
    const guarded = createOriginGuard({ allowLoopback: false });
    const res = await runThrough(guarded, {
      method: "DELETE",
      url: "/api/uploads/file_1",
      headers: { origin: EVIL, host: SELF_HOST },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/untrusted origin/i);
  });
});