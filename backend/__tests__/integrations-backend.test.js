// Integrations backend: deal.won Slack / Zapier webhook dispatch.
//
// The service-level block is pure unit tests (no database): payload builders, the
// stage-transition state machine and the allSettled fault tolerance. The
// end-to-end block exercises the management API (GET /api/integrations,
// PUT slack/zapier, POST /test) and both hook points - a single-deal update via
// PUT /api/deals/:id and a batch move via POST /api/deals/batch-move - with the
// outbound HTTP layer stubbed through vi.stubGlobal("fetch"), so CI runs with no
// network access and a hanging webhook can never fail the deal write.

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { resetTestDb, cleanupTestDb } from "./setup.js";
import { mutateDb } from "../store.js";
import { query } from "../db/pg.js";
import {
  isWonStage,
  formatCurrency,
  buildSlackDealWonPayload,
  buildZapierDealWonPayload,
  triggerDealWonIntegrations,
  saveWorkspaceIntegration,
} from "../services/integrations.js";

const ACME = "ws_acme";
const GLOBEX = "ws_globex";
const SLACK_SECRET = "xoxb-1234567890-abcdef";
const SLACK_URL = `https://hooks.slack.com/services/AAA/BBB/${SLACK_SECRET}`;
const ZAPIER_URL = "https://hooks.zapier.com/hooks/catch/111/222/";

let pgReady = false;
try {
  await query("SELECT 1 FROM deals LIMIT 1");
  pgReady = true;
} catch (error) {
  console.warn(
    `[integrations-backend] Postgres is unreachable (${error.code || error.message}) - skipping database and HTTP assertions. Set PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE and re-run.`,
  );
}

function makePassword() {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync("test123", salt, 64).toString("hex")}`;
}

async function seedSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await mutateDb((db) => {
    db.sessions.push({
      token,
      userId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });
  return token;
}

async function seedAuth() {
  await mutateDb((db) => {
    const users = [
      ["usr_integ_admin", "integadmin@test.com", "admin", ACME],
      ["usr_integ_member", "integmember@test.com", "member", ACME],
      ["usr_integ_viewer", "integviewer@test.com", "viewer", ACME],
      ["usr_integ_globex", "integglobex@test.com", "admin", GLOBEX],
    ];
    for (const [id, email, role, workspaceId] of users) {
      db.users.push({
        id,
        name: email.split("@")[0],
        email,
        password: makePassword(),
        role,
        workspaceId,
        createdAt: new Date().toISOString(),
      });
    }
  });
  tokens.admin = await seedSession("usr_integ_admin");
  tokens.member = await seedSession("usr_integ_member");
  tokens.viewer = await seedSession("usr_integ_viewer");
  tokens.globex = await seedSession("usr_integ_globex");
}

const tokens = { admin: "", member: "", viewer: "", globex: "" };
const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

let app;

async function seedDeal({ id, workspaceId = ACME, title = "Deal", stage = "lead", value = 0, contactId = null }) {
  await query(
    `INSERT INTO deals (id, workspace_id, title, stage, value, contact_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, workspaceId, title, stage, value, contactId],
  );
}

async function readDeal(id) {
  const result = await query("SELECT * FROM deals WHERE id = $1", [id]);
  return result.rows[0] || null;
}

function installFetchMock({ responder } = {}) {
  const calls = [];
  const mock = vi.fn(async (url, init) => {
    calls.push({ url, init });
    if (responder) return responder(url, init);
    return { ok: true, status: 200 };
  });
  vi.stubGlobal("fetch", mock);
  return { calls, mock };
}

const callsOf = (calls, urlPrefix) =>
  calls.filter((call) => String(call.url).startsWith(urlPrefix));

const bodyOf = (call) => (call ? JSON.parse(call.init.body) : null);

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
});

beforeEach(async () => {
  await resetTestDb();
  await seedAuth();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(() => cleanupTestDb());

// ===========================================================================
describe("Integrations service: payload builders & stage guard", () => {
  it("recognizes won stages case-insensitively", () => {
    expect(isWonStage("won")).toBe(true);
    expect(isWonStage("WON")).toBe(true);
    expect(isWonStage("Closed Won")).toBe(true);
    expect(isWonStage("closed won")).toBe(true);
    expect(isWonStage("lead")).toBe(false);
    expect(isWonStage("negotiation")).toBe(false);
    expect(isWonStage("")).toBe(false);
    expect(isWonStage(null)).toBe(false);
  });

  it("formats the amount as currency", () => {
    expect(formatCurrency(50000, "USD")).toBe("$50,000");
    expect(formatCurrency(0, "USD")).toBe("$0");
  });

  it("builds the Slack celebration payload", () => {
    const payload = buildSlackDealWonPayload({
      deal: { id: "deal_9", title: "Quantum Leap Expansion", value: 50000, stage: "won" },
      workspaceId: ACME,
    });
    expect(payload.text).toBe("🎉 Deal Won: *Quantum Leap Expansion* - $50,000");
    const blockText = payload.blocks[0].text.text;
    expect(blockText).toContain("🎉 *Deal Won!*");
    expect(blockText).toContain("*Value:* $50,000 USD");
    expect(blockText).toContain("*Workspace:* ws_acme");
  });

  it("falls back to the name field when title is absent", () => {
    const payload = buildSlackDealWonPayload({
      deal: { id: "deal_9", name: "Legacy Named Deal", value: 1200, stage: "closed won" },
      workspaceId: ACME,
    });
    expect(payload.text).toContain("*Legacy Named Deal*");
  });

  it("builds the structured Zapier outbound event", () => {
    const payload = buildZapierDealWonPayload({
      deal: { id: "deal_9", title: "Quantum Leap Expansion", value: "50000", stage: "won", contactId: "cnt_1" },
      workspaceId: ACME,
    });
    expect(payload.event).toBe("deal.won");
    expect(payload.workspaceId).toBe(ACME);
    expect(payload.timestamp).toBeTruthy();
    expect(payload.deal).toMatchObject({
      id: "deal_9",
      title: "Quantum Leap Expansion",
      value: 50000,
      currency: "USD",
      stage: "won",
      contactId: "cnt_1",
    });
  });
});

// ===========================================================================
describe("Integrations service: triggerDealWonIntegrations", () => {
  it("does not fire when the deal did not reach a won stage", async () => {
    const { calls } = installFetchMock();
    const result = await triggerDealWonIntegrations({
      deal: { id: "d", title: "Deal", stage: "qualified" },
      previousStage: "lead",
      workspaceId: ACME,
    });
    expect(result.fired).toBe(false);
    expect(result.reason).toBe("not-won");
    expect(calls).toHaveLength(0);
  });

  it("does not fire when the deal was already won", async () => {
    const { calls } = installFetchMock();
    const result = await triggerDealWonIntegrations({
      deal: { id: "d", title: "Deal", stage: "won" },
      previousStage: "won",
      workspaceId: ACME,
    });
    expect(result.fired).toBe(false);
    expect(result.reason).toBe("already-won");
    expect(calls).toHaveLength(0);
  });

  it("is a no-op when the workspace has no webhook configured", async () => {
    const { calls } = installFetchMock();
    const result = await triggerDealWonIntegrations({
      deal: { id: "d", title: "Deal", stage: "won" },
      previousStage: "lead",
      workspaceId: ACME,
    });
    expect(result.fired).toBe(false);
    expect(result.reason).toBe("unconfigured");
    expect(calls).toHaveLength(0);
  });

  it("posts to the workspace Slack and Zapier webhooks on a won transition", async () => {
    await saveWorkspaceIntegration({ workspaceId: ACME, channel: "slack", webhookUrl: SLACK_URL });
    await saveWorkspaceIntegration({ workspaceId: ACME, channel: "zapier", webhookUrl: ZAPIER_URL });
    const { calls } = installFetchMock();

    const result = await triggerDealWonIntegrations({
      deal: { id: "deal_9", title: "Quantum Leap Expansion", value: 50000, stage: "won", contactId: "cnt_1" },
      previousStage: "qualified",
      workspaceId: ACME,
    });

    expect(result.fired).toBe(true);
    const slackCalls = callsOf(calls, "https://hooks.slack.com");
    const zapierCalls = callsOf(calls, "https://hooks.zapier.com");
    expect(slackCalls).toHaveLength(1);
    expect(zapierCalls).toHaveLength(1);
    expect(slackCalls[0].init.method).toBe("POST");
    expect(slackCalls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(bodyOf(slackCalls[0]).text).toContain("$50,000");
    expect(bodyOf(zapierCalls[0]).event).toBe("deal.won");
    expect(bodyOf(zapierCalls[0]).deal.title).toBe("Quantum Leap Expansion");
  });

  it("swallows a rejected webhook instead of throwing", async () => {
    await saveWorkspaceIntegration({ workspaceId: ACME, channel: "slack", webhookUrl: SLACK_URL });
    const { calls } = installFetchMock({
      responder: () => Promise.reject(new Error("network down")),
    });

    await expect(
      triggerDealWonIntegrations({
        deal: { id: "deal_9", title: "Deal", stage: "won" },
        previousStage: "lead",
        workspaceId: ACME,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        fired: true,
        results: [expect.objectContaining({ status: "rejected" })],
      }),
    );
    expect(calls).toHaveLength(1);
  });

  it("treats a non-2xx webhook response as a rejection, still without throwing", async () => {
    await saveWorkspaceIntegration({ workspaceId: ACME, channel: "slack", webhookUrl: SLACK_URL });
    installFetchMock({ responder: () => ({ ok: false, status: 500 }) });

    await expect(
      triggerDealWonIntegrations({
        deal: { id: "deal_9", title: "Deal", stage: "won" },
        previousStage: "lead",
        workspaceId: ACME,
      }),
    ).resolves.toEqual(expect.objectContaining({ fired: true }));
  });

  it("keeps other workspaces' webhooks out of the dispatch", async () => {
    await saveWorkspaceIntegration({ workspaceId: GLOBEX, channel: "slack", webhookUrl: SLACK_URL });
    const { calls } = installFetchMock();

    const result = await triggerDealWonIntegrations({
      deal: { id: "deal_9", title: "Deal", stage: "won" },
      previousStage: "lead",
      workspaceId: ACME,
    });

    expect(result.fired).toBe(false);
    expect(result.reason).toBe("unconfigured");
    expect(calls).toHaveLength(0);
  });
});

// ===========================================================================
describe.skipIf(!pgReady)("Integrations API: configure & probe", () => {
  it("requires authentication for every endpoint", async () => {
    const get = await request(app).get("/api/integrations");
    expect(get.status).toBe(401);

    const put = await request(app)
      .put("/api/integrations/slack")
      .send({ slackWebhookUrl: SLACK_URL });
    expect(put.status).toBe(401);

    const test_ = await request(app).post("/api/integrations/test");
    expect(test_.status).toBe(401);
  });

  it("returns unconfigured when nothing has been stored", async () => {
    const res = await request(app).get("/api/integrations").set(as("admin"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      slack: { configured: false, webhookUrlMasked: "" },
      zapier: { configured: false, webhookUrlMasked: "" },
    });
  });

  it("stores and returns a masked url, never the raw secret", async () => {
    await request(app)
      .put("/api/integrations/slack")
      .set(as("admin"))
      .send({ slackWebhookUrl: SLACK_URL });

    const res = await request(app).get("/api/integrations").set(as("admin"));
    expect(res.status).toBe(200);
    expect(res.body.slack.configured).toBe(true);
    expect(res.body.slack.webhookUrlMasked).toContain("https://hooks.slack.com/");
    expect(res.body.slack.webhookUrlMasked).toContain("••••••");
    expect(res.body.slack.webhookUrlMasked).not.toContain(SLACK_SECRET);
    expect(res.body.zapier.configured).toBe(false);
  });

  it("clears a channel when an empty url is sent", async () => {
    await request(app)
      .put("/api/integrations/slack")
      .set(as("admin"))
      .send({ slackWebhookUrl: SLACK_URL });

    const cleared = await request(app)
      .put("/api/integrations/slack")
      .set(as("admin"))
      .send({ slackWebhookUrl: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.slack.configured).toBe(false);
  });

  it("rejects an http (non-tls) webhook url with 400", async () => {
    const res = await request(app)
      .put("/api/integrations/slack")
      .set(as("admin"))
      .send({ slackWebhookUrl: "http://example.com/hook" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed url with 400", async () => {
    const res = await request(app)
      .put("/api/integrations/zapier")
      .set(as("admin"))
      .send({ zapierWebhookUrl: "not a url" });
    expect(res.status).toBe(400);
  });

  it("restricts writes to admins", async () => {
    const member = await request(app)
      .put("/api/integrations/slack")
      .set(as("member"))
      .send({ slackWebhookUrl: SLACK_URL });
    expect(member.status).toBe(403);

    const viewer = await request(app)
      .put("/api/integrations/slack")
      .set(as("viewer"))
      .send({ slackWebhookUrl: SLACK_URL });
    expect(viewer.status).toBe(403);
  });

  it("answers 400 to a test ping when no webhook is configured", async () => {
    const res = await request(app).post("/api/integrations/test").set(as("admin"));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No webhook configured");
  });

  it("probes every configured webhook and reports success", async () => {
    const { calls } = installFetchMock();
    await request(app)
      .put("/api/integrations/slack")
      .set(as("admin"))
      .send({ slackWebhookUrl: SLACK_URL });

    const res = await request(app).post("/api/integrations/test").set(as("admin"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sent: ["slack"] });
    expect(callsOf(calls, "https://hooks.slack.com")).toHaveLength(1);
    expect(bodyOf(calls[0]).text).toContain("Integration test ping");
  });

  it("reports 502 when a probed webhook rejects", async () => {
    installFetchMock({ responder: () => Promise.reject(new Error("boom")) });
    await request(app)
      .put("/api/integrations/slack")
      .set(as("admin"))
      .send({ slackWebhookUrl: SLACK_URL });

    const res = await request(app).post("/api/integrations/test").set(as("admin"));
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("boom");
    expect(res.body.sent).toEqual([]);
  });
});

// ===========================================================================
describe.skipIf(!pgReady)("deal.won webhooks: single update & batch move", () => {
  it("fires Slack and Zapier when a single deal moves into won", async () => {
    await seedDeal({
      id: "deal_single",
      title: "Quantum Leap Expansion",
      stage: "qualified",
      value: 50000,
      contactId: "cnt_1",
    });
    await request(app)
      .put("/api/integrations/slack")
      .set(as("admin"))
      .send({ slackWebhookUrl: SLACK_URL });
    await request(app)
      .put("/api/integrations/zapier")
      .set(as("admin"))
      .send({ zapierWebhookUrl: ZAPIER_URL });
    const { calls } = installFetchMock();

    const res = await request(app)
      .put("/api/deals/deal_single")
      .set(as("member"))
      .send({ title: "Quantum Leap Expansion", stage: "won", value: 50000 });

    expect(res.status).toBe(200);
    expect((await readDeal("deal_single")).stage).toBe("won");

    const slackCalls = callsOf(calls, "https://hooks.slack.com");
    const zapierCalls = callsOf(calls, "https://hooks.zapier.com");
    expect(slackCalls).toHaveLength(1);
    expect(zapierCalls).toHaveLength(1);
    expect(bodyOf(slackCalls[0]).text).toContain("*Quantum Leap Expansion*");
    expect(bodyOf(slackCalls[0]).text).toContain("$50,000");
    const zapier = bodyOf(zapierCalls[0]);
    expect(zapier.event).toBe("deal.won");
    expect(zapier.workspaceId).toBe(ACME);
    expect(zapier.deal).toMatchObject({
      id: "deal_single",
      title: "Quantum Leap Expansion",
      value: 50000,
      currency: "USD",
      contactId: "cnt_1",
    });
  });

  it("fires nothing when a single deal moves to a non-won stage", async () => {
    await seedDeal({ id: "deal_notwon", stage: "lead" });
    await request(app)
      .put("/api/integrations/slack")
      .set(as("admin"))
      .send({ slackWebhookUrl: SLACK_URL });
    const { calls } = installFetchMock();

    const res = await request(app)
      .put("/api/deals/deal_notwon")
      .set(as("member"))
      .send({ title: "Deal", stage: "qualified" });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("fires once per promoted deal on a batch move, skipping already-won rows", async () => {
    await seedDeal({ id: "deal_batch_1", stage: "lead" });
    await seedDeal({ id: "deal_batch_2", stage: "won" });
    await request(app)
      .put("/api/integrations/slack")
      .set(as("admin"))
      .send({ slackWebhookUrl: SLACK_URL });
    await request(app)
      .put("/api/integrations/zapier")
      .set(as("admin"))
      .send({ zapierWebhookUrl: ZAPIER_URL });
    const { calls } = installFetchMock();

    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_batch_1", "deal_batch_2"], stage: "won" });

    expect(res.status).toBe(200);
    expect((await readDeal("deal_batch_1")).stage).toBe("won");
    expect((await readDeal("deal_batch_2")).stage).toBe("won");
    // Only deal_batch_1 (lead -> won) should have been announced.
    expect(callsOf(calls, "https://hooks.slack.com")).toHaveLength(1);
    expect(callsOf(calls, "https://hooks.zapier.com")).toHaveLength(1);
    expect(bodyOf(callsOf(calls, "https://hooks.zapier.com")[0]).deal.id).toBe("deal_batch_1");
  });

  it("keeps the 200 response and the stage update even when a webhook is down", async () => {
    await seedDeal({ id: "deal_flaky", stage: "qualified", value: 1000 });
    await request(app)
      .put("/api/integrations/slack")
      .set(as("admin"))
      .send({ slackWebhookUrl: SLACK_URL });
    await request(app)
      .put("/api/integrations/zapier")
      .set(as("admin"))
      .send({ zapierWebhookUrl: ZAPIER_URL });
    installFetchMock({ responder: () => Promise.reject(new Error("connection refused")) });

    const res = await request(app)
      .put("/api/deals/deal_flaky")
      .set(as("member"))
      .send({ title: "Deal", stage: "won", value: 1000 });

    expect(res.status).toBe(200);
    expect((await readDeal("deal_flaky")).stage).toBe("won");
  });

  it("does not leak one workspace's webhook into another workspace's event", async () => {
    await seedDeal({ id: "deal_acme", stage: "qualified" });
    // globex admin configures its own webhook.
    await request(app)
      .put("/api/integrations/slack")
      .set(as("globex"))
      .send({ slackWebhookUrl: SLACK_URL });
    const { calls } = installFetchMock();

    const res = await request(app)
      .put("/api/deals/deal_acme")
      .set(as("member"))
      .send({ title: "Deal", stage: "won" });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);

    const globexRead = await request(app).get("/api/integrations").set(as("globex"));
    expect(globexRead.body.slack.configured).toBe(true);
    const acmeRead = await request(app).get("/api/integrations").set(as("admin"));
    expect(acmeRead.body.slack.configured).toBe(false);
  });
});