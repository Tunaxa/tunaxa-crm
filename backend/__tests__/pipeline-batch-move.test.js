import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { resetTestDb, cleanupTestDb } from "./setup.js";
import { mutateDb } from "../store.js";
import { query, getPool } from "../db/pg.js";

const ACME = "ws_acme";
const GLOBEX = "ws_globex";

let app;
const tokens = { admin: "", member: "", viewer: "" };

let pgReady = false;
try {
  await query("SELECT 1 FROM deals LIMIT 1");
  pgReady = true;
} catch (error) {
  console.warn(`[pipeline-batch-move] Postgres unavailable (${error.code || error.message}); skipping DB assertions.`);
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
      ["usr_batch_admin", "batchadmin@test.com", "admin"],
      ["usr_batch_member", "batchmember@test.com", "member"],
      ["usr_batch_viewer", "batchviewer@test.com", "viewer"],
    ];
    for (const [id, email, role] of users) {
      db.users.push({
        id,
        name: email.split("@")[0],
        email,
        password: makePassword(),
        role,
        workspaceId: ACME,
        createdAt: new Date().toISOString(),
      });
    }
  });
  tokens.admin = await seedSession("usr_batch_admin");
  tokens.member = await seedSession("usr_batch_member");
  tokens.viewer = await seedSession("usr_batch_viewer");
}

const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

async function seedDeal({ id, workspaceId = ACME, title = "Deal", stage = "Lead", pipelineId = null, company = "Acme Co" }) {
  await query(
    `INSERT INTO deals (id, workspace_id, title, stage, pipeline_id, company, custom_fields)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)`,
    [id, workspaceId, title, stage, pipelineId, company],
  );
}

async function readDeal(id) {
  const result = await query("SELECT * FROM deals WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function stageActivityCount(dealId) {
  const result = await query(
    `SELECT COUNT(*)::int AS count FROM activities WHERE deal_id = $1 AND type = 'stage_change'`,
    [dealId],
  );
  return result.rows[0].count;
}

function failStatementMatching(pattern) {
  const pool = getPool();
  const realConnect = pool.connect.bind(pool);
  let armed = true;
  const spy = vi.spyOn(pool, "connect").mockImplementation(async () => {
    const client = await realConnect();
    if (client.__batchFailing) return client;
    client.__batchFailing = true;
    const realQuery = client.query.bind(client);
    client.query = (text, params) => {
      if (armed && typeof text === "string" && pattern.test(text)) {
        const error = new Error("injected failure");
        error.code = "08006";
        return Promise.reject(error);
      }
      return realQuery(text, params);
    };
    return client;
  });
  return () => {
    armed = false;
    spy.mockRestore();
  };
}

async function createPipeline(token, body) {
  return request(app)
    .post("/api/pipeline-definitions")
    .set({ Authorization: `Bearer ${token}` })
    .send(body);
}

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
});

beforeEach(async () => {
  await resetTestDb();
  await seedAuth();
});

afterAll(() => cleanupTestDb());

describe.skipIf(!pgReady)("Pipeline batch-move: atomicity & rollback", () => {
  it("moves every listed deal to the target stage in one transaction", async () => {
    await seedDeal({ id: "deal_01", stage: "Lead" });
    await seedDeal({ id: "deal_02", stage: "Lead" });
    await seedDeal({ id: "deal_03", stage: "Lead" });

    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_01", "deal_02", "deal_03"], stage: "Qualified" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.movedCount).toBe(3);

    for (const id of ["deal_01", "deal_02", "deal_03"]) {
      const deal = await readDeal(id);
      expect(deal.stage).toBe("Qualified");
      expect(await stageActivityCount(id)).toBe(1);
    }
  });

  it("supports the /api/deals/batch-stage alias", async () => {
    await seedDeal({ id: "deal_alias", stage: "Lead" });
    const res = await request(app)
      .post("/api/deals/batch-stage")
      .set(as("member"))
      .send({ dealIds: ["deal_alias"], stage: "Negotiation" });
    expect(res.status).toBe(200);
    expect(res.body.movedCount).toBe(1);
    expect((await readDeal("deal_alias")).stage).toBe("Negotiation");
  });

  it("rolls the whole batch back when any id does not resolve", async () => {
    await seedDeal({ id: "deal_01", stage: "Lead" });
    await seedDeal({ id: "deal_02", stage: "Lead" });
    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_01", "not_a_deal", "deal_02"], stage: "Won" });
    expect(res.status).toBe(404);
    expect((await readDeal("deal_01")).stage).toBe("Lead");
    expect((await readDeal("deal_02")).stage).toBe("Lead");
    expect(await stageActivityCount("deal_01")).toBe(0);
    expect(await stageActivityCount("deal_02")).toBe(0);
  });

  it("rolls back when one deal belongs to another tenant workspace", async () => {
    await seedDeal({ id: "deal_acme", workspaceId: ACME, stage: "Lead" });
    await seedDeal({ id: "deal_globex", workspaceId: GLOBEX, stage: "Lead" });
    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_acme", "deal_globex"], stage: "Proposal" });
    expect(res.status).toBe(404);
    expect((await readDeal("deal_acme")).stage).toBe("Lead");
    expect((await readDeal("deal_globex")).stage).toBe("Lead");
    expect(await stageActivityCount("deal_acme")).toBe(0);
    expect(await stageActivityCount("deal_globex")).toBe(0);
  });

  it("aborts and rolls back when a statement fails after the UPDATE", async () => {
    await seedDeal({ id: "deal_a", stage: "Proposal" });
    await seedDeal({ id: "deal_b", stage: "Proposal" });
    await seedDeal({ id: "deal_c", stage: "Proposal" });
    const disarm = failStatementMatching(/^\s*INSERT\s+INTO\s+activities\b/i);
    let res;
    try {
      res = await request(app)
        .post("/api/deals/batch-move")
        .set(as("admin"))
        .send({ dealIds: ["deal_a", "deal_b", "deal_c"], stage: "Won" });
    } finally {
      disarm();
    }
    expect(res.status).toBe(500);
    for (const id of ["deal_a", "deal_b", "deal_c"]) {
      expect((await readDeal(id)).stage).toBe("Proposal");
      expect(await stageActivityCount(id)).toBe(0);
    }
  });

  it("deduplicates repeated ids instead of auditing a deal twice", async () => {
    await seedDeal({ id: "deal_dup", stage: "Lead" });
    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_dup", "deal_dup", "deal_dup"], stage: "Qualified" });
    expect(res.status).toBe(200);
    expect(res.body.movedCount).toBe(1);
    expect((await readDeal("deal_dup")).stage).toBe("Qualified");
    expect(await stageActivityCount("deal_dup")).toBe(1);
  });
});

describe.skipIf(!pgReady)("Pipeline batch-move: tenant-scoped pipeline definitions", () => {
  it("validates custom pipeline stage and syncs stage side effects", async () => {
    const pipelineRes = await createPipeline(tokens.admin, {
      name: "Custom Sales",
      entityType: "deal",
      isDefault: true,
      stages: [
        { key: "discovery", label: "Discovery", probability: 20, order: 0 },
        { key: "commit", label: "Commit", probability: 80, order: 1 },
      ],
    });
    expect(pipelineRes.status).toBe(201);
    const pipelineId = pipelineRes.body.id;
    await seedDeal({ id: "deal_custom", stage: "Discovery", pipelineId });
    await query(
      `INSERT INTO contacts (id, workspace_id, first_name, last_name, email)
       VALUES ($1, $2, 'Jane', 'Doe', 'jane@acme.test')`,
      ["cnt_acme", ACME],
    );

    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_custom"], stage: "commit", pipelineId });
    expect(res.status).toBe(200);
    const deal = await readDeal("deal_custom");
    expect(deal.stage).toBe("Commit");
    expect(deal.pipeline_id).toBe(pipelineId);
    expect(deal.custom_fields?.probability).toBe(80);
    expect(deal.custom_fields?.prevStage).toBe("Discovery");
    expect(typeof deal.custom_fields?.stageChangedAt).toBe("string");
    expect(await stageActivityCount("deal_custom")).toBe(1);
  });

  it("rejects stage not defined in resolved pipeline with 400", async () => {
    const pipelineRes = await createPipeline(tokens.admin, {
      name: "Limited",
      entityType: "deal",
      isDefault: true,
      stages: [{ key: "open", label: "Open", probability: 10, order: 0 }],
    });
    expect(pipelineRes.status).toBe(201);
    await seedDeal({ id: "deal_limited", stage: "Open", pipelineId: pipelineRes.body.id });
    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_limited"], stage: "Qualified", pipelineId: pipelineRes.body.id });
    expect(res.status).toBe(400);
    expect((await readDeal("deal_limited")).stage).toBe("Open");
  });

  it("rejects cross-tenant pipelineId with 404", async () => {
    await mutateDb((db) => {
      db.pipelineDefinitions = Array.isArray(db.pipelineDefinitions) ? db.pipelineDefinitions : [];
      db.pipelineDefinitions.push({
        id: "pipe_globex",
        workspaceId: GLOBEX,
        name: "Globex",
        entityType: "deal",
        isDefault: true,
        stages: [{ key: "open", label: "Open", probability: 10, order: 0 }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    await query(
      `INSERT INTO pipeline_definitions (id, workspace_id, name, entity_type, is_default, stages)
       VALUES ($1, $2, 'Globex', 'deal', true, $3::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      ["pipe_globex", GLOBEX, JSON.stringify([{ key: "open", label: "Open", probability: 10, order: 0 }])],
    ).catch(() => {});

    await seedDeal({ id: "deal_acme_pipe", stage: "Lead" });
    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_acme_pipe"], stage: "Open", pipelineId: "pipe_globex" });
    expect(res.status).toBe(404);
    expect((await readDeal("deal_acme_pipe")).stage).toBe("Lead");
  });
});

describe.skipIf(!pgReady)("Pipeline batch-move: RBAC & field mask", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app).post("/api/deals/batch-move").send({ dealIds: ["x"], stage: "Qualified" });
    expect(res.status).toBe(401);
  });

  it("blocks viewer-role users from triggering a batch move", async () => {
    await seedDeal({ id: "deal_viewer", stage: "Lead" });
    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("viewer"))
      .send({ dealIds: ["deal_viewer"], stage: "Qualified" });
    expect(res.status).toBe(403);
    expect((await readDeal("deal_viewer")).stage).toBe("Lead");
  });

  it("rejects a write to a field masked by RBAC with 403", async () => {
    await seedDeal({ id: "deal_mask", stage: "Lead" });
    await mutateDb((db) => {
      db.fieldPermissions = { deal: { member: { visible: null, hidden: ["stage"] } } };
    });
    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("member"))
      .send({ dealIds: ["deal_mask"], stage: "Qualified" });
    expect(res.status).toBe(403);
    expect((await readDeal("deal_mask")).stage).toBe("Lead");
  });
});

describe("Pipeline batch-move: validation & security", () => {
  it("rejects empty dealIds with 400", async () => {
    const res = await request(app).post("/api/deals/batch-move").set(as("admin")).send({ dealIds: [], stage: "Qualified" });
    expect(res.status).toBe(400);
  });

  it("rejects more than 100 dealIds with 400", async () => {
    const dealIds = Array.from({ length: 101 }, (_, i) => `deal_${i}`);
    const res = await request(app).post("/api/deals/batch-move").set(as("admin")).send({ dealIds, stage: "Qualified" });
    expect(res.status).toBe(400);
  });

  it("rejects unknown keys with 400", async () => {
    const res = await request(app).post("/api/deals/batch-move").set(as("admin")).send({ dealIds: ["d1"], stage: "Qualified", extra: true });
    expect(res.status).toBe(400);
  });

  it("rejects prototype pollution keys with 400", async () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const payload = JSON.parse(`{"dealIds":["d1"],"stage":"Qualified","${key}":{"polluted":true}}`);
      const res = await request(app).post("/api/deals/batch-move").set(as("admin")).send(payload);
      expect(res.status).toBe(400);
    }
  });
});

