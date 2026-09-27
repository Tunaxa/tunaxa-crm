import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { resetTestDb, cleanupTestDb } from "./setup.js";
import { readDb, mutateDb } from "../store.js";

let app;

// Rate limiting note: /api/auth/refresh is capped at 30 requests/minute per IP
// and /api/auth/login at 10/minute, and every request here comes from
// 127.0.0.1, so this file shares both buckets. Tests therefore seed session
// records directly instead of logging in for each case, and only the regression
// block calls the real login route. A surprising 429 means this file outgrew a
// bucket.
function makePassword() {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("test123", salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function seededUser(id, name, email, role) {
  return {
    id,
    name,
    email,
    password: makePassword(),
    role,
    createdAt: new Date().toISOString(),
  };
}

/** Writes a valid session straight into the store, the way /login would. */
async function seedSession(userId, overrides = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  await mutateDb((db) => {
    db.sessions.push({
      token,
      userId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    });
  });
  return token;
}

async function login(email) {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email, password: "test123" });
  expect(res.status).toBe(200);
  return res.body.token;
}

async function sessionCount() {
  return (await readDb()).sessions.length;
}

async function findSession(token) {
  return (await readDb()).sessions.find((x) => x.token === token);
}

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
  await mutateDb((db) => {
    db.users.unshift(seededUser("usr_owner", "Owner", "owner@test.com", "Owner"));
    db.users.unshift(seededUser("usr_member", "Member", "member@test.com", "member"));
  });
});

afterAll(() => cleanupTestDb());

describe("POST /api/auth/refresh", () => {
  it("rotates a valid session and returns a fresh opaque token", async () => {
    const token = await seedSession("usr_owner");

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: token });

    expect(res.status).toBe(200);
    // Tokens are 32 random bytes as hex, matching /api/auth/login.
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
    // Guards the architecture decision: these are opaque server-side session
    // tokens, NOT JWTs. A JWT would be rejected by every other endpoint because
    // middleware/auth.js resolves tokens by db.sessions lookup.
    expect(res.body.token.split(".")).toHaveLength(1);
    expect(res.body.token).not.toBe(token);

    // Same response shape as /api/auth/login.
    expect(res.body.user).toEqual({
      id: "usr_owner",
      name: "Owner",
      email: "owner@test.com",
      role: "Owner",
    });
  });

  it("never returns the password hash", async () => {
    const token = await seedSession("usr_owner");
    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: token });

    expect(res.status).toBe(200);
    expect(res.body.user.password).toBeUndefined();
    expect(Object.keys(res.body.user).sort()).toEqual(["email", "id", "name", "role"]);

    // The response only omitted it -- the hash is still in the store.
    const stored = (await readDb()).users.find((u) => u.id === "usr_owner");
    expect(stored.password).toBeTruthy();
  });

  it("issues a token that authenticates, and revokes the presented one", async () => {
    const original = await seedSession("usr_owner");
    const refreshed = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: original });
    const nextToken = refreshed.body.token;

    // The new token works on a normal authenticated route.
    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${nextToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("owner@test.com");

    // The old token no longer authenticates.
    const stale = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${original}`);
    expect(stale.status).toBe(401);

    // ...and cannot be replayed against refresh, so a captured token is
    // single-use once the real client refreshes.
    const replay = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: original });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("Invalid refresh token");
  });

  it("accepts the token from body.token, x-refresh-token, and Authorization", async () => {
    const first = await seedSession("usr_owner");

    const viaTokenField = await request(app)
      .post("/api/auth/refresh")
      .send({ token: first });
    expect(viaTokenField.status).toBe(200);
    const second = viaTokenField.body.token;

    const viaHeader = await request(app)
      .post("/api/auth/refresh")
      .set("x-refresh-token", second);
    expect(viaHeader.status).toBe(200);
    const third = viaHeader.body.token;

    const viaBearer = await request(app)
      .post("/api/auth/refresh")
      .set("Authorization", `Bearer ${third}`);
    expect(viaBearer.status).toBe(200);

    // Chained rotation, each step invalidating the previous token.
    expect(new Set([first, second, third, viaBearer.body.token]).size).toBe(4);
  });

  it("records a session refresh audit entry", async () => {
    const token = await seedSession("usr_owner");
    const before = (await readDb()).audit.length;

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: token });
    expect(res.status).toBe(200);

    const audit = (await readDb()).audit;
    expect(audit.length).toBe(before + 1);
    expect(audit[0].action).toBe("Session refreshed");
    expect(audit[0].actor).toBe("Owner");
  });

  it("rotates rather than accumulating sessions", async () => {
    const token = await seedSession("usr_owner");
    const before = await sessionCount();

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: token });

    expect(res.status).toBe(200);
    expect(res.body.token).not.toBe(token);
    expect(await sessionCount()).toBe(before);
  });
});

describe("POST /api/auth/refresh rejections", () => {
  it("rejects a request with no token", async () => {
    const res = await request(app).post("/api/auth/refresh").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Refresh token is required");
  });

  it("rejects an empty or whitespace-only token", async () => {
    const empty = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "" });
    expect(empty.status).toBe(400);

    const blank = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "   " });
    expect(blank.status).toBe(400);
  });

  it("rejects a token that is not in the session store", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: crypto.randomBytes(32).toString("hex") });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid refresh token");
  });

  it("rejects a malformed token", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "not-a-real-token" });
    expect(res.status).toBe(401);
  });

  it("rejects an expired session and reaps the dead record", async () => {
    const token = await seedSession("usr_owner", {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: token });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Refresh token has expired");

    // Expired records are removed rather than left to be retried forever.
    expect(await findSession(token)).toBeUndefined();
  });

  it("rejects a session whose user no longer exists and reaps it", async () => {
    const token = await seedSession("usr_deleted_long_ago");

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: token });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("User not found");

    expect(await findSession(token)).toBeUndefined();
  });

  it("rejects a token belonging to a user deleted through the API", async () => {
    const memberToken = await seedSession("usr_member");
    const ownerToken = await login("owner@test.com");

    const del = await request(app)
      .delete("/api/users/usr_member")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(del.status).toBe(200);

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: memberToken });
    expect(res.status).toBe(401);
  });
});

describe("auth regression after the refresh fix", () => {
  it("still issues working tokens from /api/auth/login", async () => {
    const token = await login("owner@test.com");
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe("usr_owner");
  });

  it("still rejects bad credentials and unauthenticated access", async () => {
    const bad = await request(app)
      .post("/api/auth/login")
      .send({ email: "owner@test.com", password: "wrong" });
    expect(bad.status).toBe(401);

    const anon = await request(app).get("/api/auth/me");
    expect(anon.status).toBe(401);
  });

  it("keeps the public health route and auth status route working", async () => {
    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);

    const status = await request(app).get("/api/auth/status");
    expect(status.status).toBe(200);
    expect(status.body.needsSetup).toBe(false);
  });
});
