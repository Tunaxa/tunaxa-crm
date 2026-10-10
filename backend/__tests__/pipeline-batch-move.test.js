// Pipeline batch-move atomicity & rollback guarantees.
//
// POST /api/deals/batch-move moves a list of deals to one stage inside a
// single PostgreSQL transaction. The property under test on every rollback
// case is the same one the merge suite cares about: a rejection is only a
// control if nothing was written behind it. So every failure test re-reads the
// affected deals from PostgreSQL and asserts their stage is byte-identical to
// the pre-request snapshot, and that no stage-change activity was recorded.

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

// Probed at module scope on purpose. `describe.skipIf()` is evaluated while
// Vitest is still collecting files, before any `beforeAll` runs, so a flag set
// inside a hook would skip every database assertion.
let pgReady = false;
try {
  await query("SELECT 1 FROM deals LIMIT 1");
  pgReady = true;
} catch (error) {
  console.warn(
    `[pipeline-batch-move] Postgres is unreachable (${error.code || error.message}) - skipping database and HTTP assertions. Set PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE and re-run.`,
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

/** Seed the three roles used across the suite in the JSON auth store. */
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

async function seedDeal({ id, workspaceId = ACME, title = "Deal", stage = "lead" }) {
  await query(
    `INSERT INTO deals (id, workspace_id, title, stage)
     VALUES ($1, $2, $3, $4)`,
    [id, workspaceId, title, stage],
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

/**
 * Make the next pool checkout fail on one statement class.
 *
 * Mirrors the injection used by atomic-merge-fuzzy.test.js: the wrapper lives
 * on the pooled client (which is recycled), so it is gated on a mutable flag
 * and a per-client stamp instead of being torn off. `disarm()` leaves a
 * pass-through in place for every later test that borrows the same client.
 */
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
        const error = new Error("injected failure: statement failed mid-batch-move");
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

// ===========================================================================
describe.skipIf(!pgReady)("Pipeline batch-move: atomicity & rollback", () => {
  it("moves every listed deal to the target stage in one transaction", async () => {
    await seedDeal({ id: "deal_01", stage: "lead" });
    await seedDeal({ id: "deal_02", stage: "lead" });
    await seedDeal({ id: "deal_03", stage: "lead" });

    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_01", "deal_02", "deal_03"], stage: "qualified" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, movedCount: 3, stage: "qualified" });
    expect(res.body.dealIds).toEqual(["deal_01", "deal_02", "deal_03"]);

    for (const id of ["deal_01", "deal_02", "deal_03"]) {
      expect((await readDeal(id)).stage).toBe("qualified");
      expect(await stageActivityCount(id)).toBe(1);
    }
  });

  it("supports the /api/deals/batch-stage alias", async () => {
    await seedDeal({ id: "deal_alias" });

    const res = await request(app)
      .post("/api/deals/batch-stage")
      .set(as("member"))
      .send({ dealIds: ["deal_alias"], stage: "negotiation" });

    expect(res.status).toBe(200);
    expect(res.body.movedCount).toBe(1);
    expect((await readDeal("deal_alias")).stage).toBe("negotiation");
  });

  it("rolls the whole batch back when any id does not resolve", async () => {
    await seedDeal({ id: "deal_01", stage: "lead" });
    await seedDeal({ id: "deal_02", stage: "lead" });

    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_01", "not_a_deal", "deal_02"], stage: "won" });

    expect(res.status).toBe(404);

    for (const id of ["deal_01", "deal_02"]) {
      expect((await readDeal(id)).stage).toBe("lead");
      expect(await stageActivityCount(id)).toBe(0);
    }
  });

  it("rolls back when one deal belongs to another tenant workspace", async () => {
    await seedDeal({ id: "deal_acme", workspaceId: ACME, stage: "lead" });
    await seedDeal({ id: "deal_globex", workspaceId: GLOBEX, stage: "lead" });

    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_acme", "deal_globex"], stage: "proposal" });

    expect(res.status).toBe(404);

    expect((await readDeal("deal_acme")).stage).toBe("lead");
    expect((await readDeal("deal_globex")).stage).toBe("lead");
    expect(await stageActivityCount("deal_acme")).toBe(0);
    expect(await stageActivityCount("deal_globex")).toBe(0);
  });

  it("aborts and rolls back when a statement fails after the UPDATE", async () => {
    await seedDeal({ id: "deal_a", stage: "proposal" });
    await seedDeal({ id: "deal_b", stage: "proposal" });
    await seedDeal({ id: "deal_c", stage: "proposal" });

    // Fail the audit INSERT, which runs after the deals UPDATE in the same
    // transaction: if the rollback did not happen, the stages would already be
    // updated. This proves partial committed writes are discarded.
    const disarm = failStatementMatching(/^\s*INSERT\s+INTO\s+activities\b/i);
    let res;
    try {
      res = await request(app)
        .post("/api/deals/batch-move")
        .set(as("admin"))
        .send({ dealIds: ["deal_a", "deal_b", "deal_c"], stage: "won" });
    } finally {
      disarm();
    }

    expect(res.status).toBe(500);

    for (const id of ["deal_a", "deal_b", "deal_c"]) {
      expect((await readDeal(id)).stage).toBe("proposal");
      expect(await stageActivityCount(id)).toBe(0);
    }
  });

  it("deduplicates repeated ids instead of auditing a deal twice", async () => {
    await seedDeal({ id: "deal_dup", stage: "lead" });

    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_dup", "deal_dup", "deal_dup"], stage: "qualified" });

    expect(res.status).toBe(200);
    expect(res.body.movedCount).toBe(1);
    expect(res.body.dealIds).toEqual(["deal_dup"]);
    expect((await readDeal("deal_dup")).stage).toBe("qualified");
    expect(await stageActivityCount("deal_dup")).toBe(1);
  });
});

// ===========================================================================
describe.skipIf(!pgReady)("Pipeline batch-move: validation & RBAC", () => {
  it("rejects an empty or missing dealIds array with 400", async () => {
    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: [], stage: "qualified" });
    expect(res.status).toBe(400);

    const missing = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ stage: "qualified" });
    expect(missing.status).toBe(400);
  });

  it("rejects a missing or empty stage with 400", async () => {
    await seedDeal({ id: "deal_validate" });

    const missing = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_validate"] });
    expect(missing.status).toBe(400);

    const empty = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_validate"], stage: "  " });
    expect(empty.status).toBe(400);

    expect((await readDeal("deal_validate")).stage).toBe("lead");
  });

  it("rejects an unrecognized stage with 400", async () => {
    await seedDeal({ id: "deal_stage" });

    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_stage"], stage: "funnel" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNKNOWN_STAGE");
    expect((await readDeal("deal_stage")).stage).toBe("lead");
  });

  it("blocks viewer-role users from triggering a batch move", async () => {
    await seedDeal({ id: "deal_viewer" });

    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("viewer"))
      .send({ dealIds: ["deal_viewer"], stage: "qualified" });
    expect(res.status).toBe(403);
    expect((await readDeal("deal_viewer")).stage).toBe("lead");
  });

  it("rejects a write to a field masked by RBAC with 403", async () => {
    await seedDeal({ id: "deal_mask", stage: "lead" });
    await mutateDb((db) => {
      db.fieldPermissions = {
        deal: { member: { visible: null, hidden: ["stage"] } },
      };
    });

    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("member"))
      .send({ dealIds: ["deal_mask"], stage: "qualified" });
    expect(res.status).toBe(403);
    expect(res.body.maskedFields).toContain("stage");
    expect((await readDeal("deal_mask")).stage).toBe("lead");
  });

  it("lets admins move a deal whose field is masked for other roles", async () => {
    await seedDeal({ id: "deal_mask_admin", stage: "lead" });
    await mutateDb((db) => {
      db.fieldPermissions = {
        deal: { member: { visible: null, hidden: ["stage"] } },
      };
    });

    const res = await request(app)
      .post("/api/deals/batch-move")
      .set(as("admin"))
      .send({ dealIds: ["deal_mask_admin"], stage: "qualified" });
    expect(res.status).toBe(200);
    expect((await readDeal("deal_mask_admin")).stage).toBe("qualified");
  });
});