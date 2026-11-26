import crypto from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closePool, query } from "../db/pg.js";
import { mutateDb } from "../store.js";
import { deliverWebhook } from "../workers/webhookWorker.js";
import { assertSafeWebhookUrl } from "../services/webhookSecurity.js";
import { resetTestDb } from "./setup.js";

const ACME = "acme_ws";
const GLOBEX = "globex_ws";

let app;
let acmeToken;
let globexToken;
let viewerToken;

function passwordHash() {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("test123", salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

async function seedUser({ id, email, role, workspaceId }) {
  const now = new Date().toISOString();
  await mutateDb((db) => {
    db.users.push({
      id,
      name: email,
      email,
      password: passwordHash(),
      role,
      workspaceId,
      createdAt: now,
    });
    db.team.push({
      id: `team_${id}`,
      name: email,
      email,
      role,
      status: "Active",
      createdAt: now,
    });
  });
}

async function login(email) {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email, password: "test123" });
  if (!res.body.token) throw new Error(`Login failed for ${email}`);
  return res.body.token;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  await resetTestDb();
  await query(
    "TRUNCATE TABLE webhook_delivery_attempts, webhook_events, webhook_subscriptions CASCADE;",
  );
  app = (await import("../server.js")).app;
  await seedUser({ id: "usr_acme", email: "acme@test.com", role: "Owner", workspaceId: ACME });
  await seedUser({ id: "usr_globex", email: "globex@test.com", role: "Owner", workspaceId: GLOBEX });
  await seedUser({ id: "usr_viewer", email: "viewer@test.com", role: "viewer", workspaceId: ACME });
  acmeToken = await login("acme@test.com");
  globexToken = await login("globex@test.com");
  viewerToken = await login("viewer@test.com");
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await closePool();
});

describe("outgoing webhook frontend contract", () => {
  let acmeId;
  let globexId;

  it("returns the one-time secret with hasSecret on creation", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .set(auth(acmeToken))
      .send({ url: "https://example.com/acme-hook", events: ["contact.created"] });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_[a-f0-9]{64}$/u);
    expect(res.body.hasSecret).toBe(true);
    expect(res.body.id).toBeTruthy();
    acmeId = res.body.id;
  });

  it("scopes lists to the caller workspace", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .set(auth(globexToken))
      .send({ url: "https://example.org/globex-hook", events: ["deal.won"] });
    expect(res.status).toBe(201);
    globexId = res.body.id;

    const acmeList = await request(app).get("/api/v1/webhooks").set(auth(acmeToken));
    const globexList = await request(app).get("/api/v1/webhooks").set(auth(globexToken));
    expect(acmeList.status).toBe(200);
    expect(acmeList.body.data.map((row) => row.id)).toContain(acmeId);
    expect(acmeList.body.data.map((row) => row.id)).not.toContain(globexId);
    expect(globexList.body.data.map((row) => row.id)).toContain(globexId);
    expect(globexList.body.data.map((row) => row.id)).not.toContain(acmeId);
  });

  it("returns 404 for cross-workspace detail, update and delete", async () => {
    const detail = await request(app)
      .get(`/api/v1/webhooks/${acmeId}`)
      .set(auth(globexToken));
    expect(detail.status).toBe(404);
    expect(detail.body).not.toHaveProperty("secret");
    expect(detail.body).not.toHaveProperty("url");

    const update = await request(app)
      .patch(`/api/v1/webhooks/${acmeId}`)
      .set(auth(globexToken))
      .send({ is_active: false });
    expect(update.status).toBe(404);

    const remove = await request(app)
      .delete(`/api/v1/webhooks/${acmeId}`)
      .set(auth(globexToken));
    expect(remove.status).toBe(404);

    const stillThere = await request(app)
      .get(`/api/v1/webhooks/${acmeId}`)
      .set(auth(acmeToken));
    expect(stillThere.status).toBe(200);
  });

  it("never exposes the raw secret on read or update responses", async () => {
    const detail = await request(app)
      .get(`/api/v1/webhooks/${acmeId}`)
      .set(auth(acmeToken));
    expect(detail.status).toBe(200);
    expect(detail.body.hasSecret).toBe(true);
    expect(detail.body).not.toHaveProperty("secret");

    const updated = await request(app)
      .patch(`/api/v1/webhooks/${acmeId}`)
      .set(auth(acmeToken))
      .send({ is_active: false });
    expect(updated.status).toBe(200);
    expect(updated.body.hasSecret).toBe(true);
    expect(updated.body).not.toHaveProperty("secret");
    expect(JSON.stringify(updated.body)).not.toContain("whsec_");
  });

  it("validates is_active as a strict boolean", async () => {
    const res = await request(app)
      .patch(`/api/v1/webhooks/${acmeId}`)
      .set(auth(acmeToken))
      .send({ is_active: "false" });
    expect(res.status).toBe(400);
  });

  it.each([
    "http://127.0.0.1",
    "http://localhost",
    "http://10.0.0.1",
    "http://169.254.169.254",
    "http://[::1]",
    "javascript:alert(1)",
    "file:///tmp/x",
    "https://user:password@example.com",
  ])("rejects unsafe destination %s", async (url) => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .set(auth(acmeToken))
      .send({ url, events: ["contact.created"] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("whsec_");
  });

  it("blocks private and local addresses in the shared SSRF guard", async () => {
    for (const value of [
      "127.0.0.1",
      "localhost",
      "10.0.0.1",
      "169.254.169.254",
      "::1",
      "fc00::1",
      "fe80::1",
      "172.16.0.1",
      "192.168.1.1",
    ]) {
      await expect(assertSafeWebhookUrl(`https://${value}`)).rejects.toThrow();
    }
  });

  it("keeps viewer roles read-only", async () => {
    const list = await request(app).get("/api/v1/webhooks").set(auth(viewerToken));
    expect(list.status).toBe(200);
    const create = await request(app)
      .post("/api/v1/webhooks")
      .set(auth(viewerToken))
      .send({ url: "https://example.com/viewer-hook", events: ["contact.created"] });
    expect(create.status).toBe(403);
    const update = await request(app)
      .patch(`/api/v1/webhooks/${acmeId}`)
      .set(auth(viewerToken))
      .send({ is_active: true });
    expect(update.status).toBe(403);
    const remove = await request(app)
      .delete(`/api/v1/webhooks/${globexId}`)
      .set(auth(viewerToken));
    expect(remove.status).toBe(403);
  });

  it("re-checks destinations and disables redirects in the delivery worker", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 302,
      ok: false,
      statusText: "Found",
      headers: new Map(),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        deliverWebhook({
          data: {
            event_id: "evt_1",
            url: "http://127.0.0.1/hook",
            secret: "whsec_test",
            payload: { event: "contact.created" },
          },
        }),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();

      await expect(
        deliverWebhook({
          data: {
            event_id: "evt_2",
            url: "https://example.com/hook",
            secret: "whsec_test",
            payload: { event: "contact.created" },
          },
        }),
      ).rejects.toThrow(/redirects/u);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        method: "POST",
        redirect: "manual",
      });
      expect(fetchMock.mock.calls[0][1].signal).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
