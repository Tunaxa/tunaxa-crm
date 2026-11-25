import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { closePool, query } from "../db/pg.js";
import { mutateDb } from "../store.js";
import { cleanupTestDb, resetTestDb } from "./setup.js";

let app;
let adminToken;
let ownerToken;
let memberToken;
let viewerToken;
let tenantToken;

const STAGES = [
  { key: "new", label: "New", probability: 10, order: 0 },
  { key: "won", label: "Won", probability: 100, order: 1 },
];
const ALTERNATE_STAGES = [
  { key: "lead", label: "Lead", probability: 25, order: 0 },
  { key: "closed", label: "Closed", probability: 100, order: 1 },
];
const WORKSPACES = ["default", "tenant-contract", "guard-last", "guard-deals"];

const as = (token) => ({ Authorization: `Bearer ${token}` });

async function createUser(email, role, workspaceId = "default") {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("test123", salt, 64).toString("hex");
  await mutateDb((db) => {
    db.users.push({
      id: `usr_${email}`,
      name: email,
      email,
      password: `${salt}:${hash}`,
      role,
      workspaceId,
      createdAt: new Date().toISOString(),
    });
  });
  const response = await request(app)
    .post("/api/auth/login")
    .send({ email, password: "test123" });
  if (response.status !== 200 || typeof response.body.token !== "string") {
    throw new Error(`login failed for ${email}: ${response.status}`);
  }
  return response.body.token;
}

async function createPipeline(token, body) {
  return request(app)
    .post("/api/pipeline-definitions")
    .set(as(token))
    .send(body);
}

async function deleteDefinitions(workspaces) {
  try {
    await query(
      `DELETE FROM pipeline_definitions WHERE workspace_id = ANY($1)`,
      [workspaces],
    );
    await query(`DELETE FROM deals WHERE workspace_id = ANY($1)`, [workspaces]);
  } catch {
    return;
  }
}

beforeAll(async () => {
  await resetTestDb();
  const module = await import("../server.js");
  app = module.app;
  adminToken = await createUser("contract-admin@test.com", "admin");
  ownerToken = await createUser("contract-owner@test.com", "owner");
  memberToken = await createUser("contract-member@test.com", "member");
  viewerToken = await createUser("contract-viewer@test.com", "viewer");
  tenantToken = await createUser(
    "contract-tenant@test.com",
    "Owner",
    "tenant-contract",
  );
});

afterAll(async () => {
  await deleteDefinitions(WORKSPACES);
  await mutateDb((db) => {
    db.pipelineDefinitions = (db.pipelineDefinitions || []).filter(
      (row) => !WORKSPACES.includes(row.workspaceId || row.workspace_id),
    );
    db.deals = (db.deals || []).filter(
      (row) => !WORKSPACES.includes(row.workspaceId || row.workspace_id),
    );
  });
  await cleanupTestDb();
  await closePool();
});

describe("pipeline definition frontend contract - RBAC", () => {
  it("allows admin and owner definitions and rejects member and viewer mutations", async () => {
    const adminCreated = await createPipeline(adminToken, {
      name: "Admin definition",
      stages: STAGES,
    });
    expect(adminCreated.status).toBe(201);
    expect(adminCreated.body).toMatchObject({
      name: "Admin definition",
      entityType: "deal",
      isDefault: false,
    });

    const ownerCreated = await createPipeline(ownerToken, {
      name: "Owner definition",
      entityType: "lead",
      stages: ALTERNATE_STAGES,
    });
    expect(ownerCreated.status).toBe(201);
    expect(ownerCreated.body.entityType).toBe("lead");

    for (const token of [memberToken, viewerToken]) {
      const rejected = await createPipeline(token, {
        name: "Forbidden definition",
        stages: STAGES,
      });
      expect(rejected.status).toBe(403);
      const update = await request(app)
        .put(`/api/pipeline-definitions/${adminCreated.body.id}`)
        .set(as(token))
        .send({ isDefault: true });
      expect(update.status).toBe(403);
      const remove = await request(app)
        .delete(`/api/pipeline-definitions/${adminCreated.body.id}`)
        .set(as(token));
      expect(remove.status).toBe(403);
    }
  });

  it("rejects a decimal probability with 400", async () => {
    const response = await createPipeline(adminToken, {
      name: "Decimal probability",
      stages: [{ key: "new", label: "New", probability: 12.5 }],
    });
    expect(response.status).toBe(400);
  });
});

describe("pipeline definition frontend contract - CRUD", () => {
  it("creates, lists, reads, updates and deletes a definition", async () => {
    const created = await createPipeline(adminToken, {
      name: "Lifecycle definition",
      entityType: "deal",
      isDefault: false,
      stages: STAGES,
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const list = await request(app)
      .get("/api/pipeline-definitions")
      .set(as(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.some((row) => row.id === id)).toBe(true);

    const read = await request(app)
      .get(`/api/pipeline-definitions/${id}`)
      .set(as(adminToken));
    expect(read.status).toBe(200);
    expect(read.body.name).toBe("Lifecycle definition");

    const updated = await request(app)
      .put(`/api/pipeline-definitions/${id}`)
      .set(as(adminToken))
      .send({ name: "Renamed definition", stages: ALTERNATE_STAGES });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("Renamed definition");
    expect(updated.body.stages[0].key).toBe("lead");

    const removed = await request(app)
      .delete(`/api/pipeline-definitions/${id}`)
      .set(as(adminToken));
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ ok: true, id });

    const afterDelete = await request(app)
      .get(`/api/pipeline-definitions/${id}`)
      .set(as(adminToken));
    expect(afterDelete.status).toBe(404);
  });

  it("switches the default definition without creating two defaults", async () => {
    const first = await createPipeline(adminToken, {
      name: "Default one",
      entityType: "deal",
      isDefault: true,
      stages: STAGES,
    });
    expect(first.status).toBe(201);
    const second = await createPipeline(adminToken, {
      name: "Default two",
      entityType: "deal",
      isDefault: false,
      stages: STAGES,
    });
    expect(second.status).toBe(201);

    const switched = await request(app)
      .put(`/api/pipeline-definitions/${second.body.id}`)
      .set(as(adminToken))
      .send({
        name: second.body.name,
        entityType: second.body.entityType,
        isDefault: true,
        stages: second.body.stages,
      });
    expect(switched.status).toBe(200);
    expect(switched.body.isDefault).toBe(true);

    const previous = await request(app)
      .get(`/api/pipeline-definitions/${first.body.id}`)
      .set(as(adminToken));
    expect(previous.status).toBe(200);
    expect(previous.body.isDefault).toBe(false);
  });
});

describe("pipeline definition frontend contract - isolation and guards", () => {
  it("returns 404 for another tenant's definition", async () => {
    const tenantPipeline = await createPipeline(tenantToken, {
      name: "Tenant definition",
      stages: STAGES,
    });
    expect(tenantPipeline.status).toBe(201);
    const id = tenantPipeline.body.id;

    const read = await request(app)
      .get(`/api/pipeline-definitions/${id}`)
      .set(as(adminToken));
    expect(read.status).toBe(404);

    const update = await request(app)
      .put(`/api/pipeline-definitions/${id}`)
      .set(as(adminToken))
      .send({ isDefault: true });
    expect(update.status).toBe(404);

    const remove = await request(app)
      .delete(`/api/pipeline-definitions/${id}`)
      .set(as(adminToken));
    expect(remove.status).toBe(404);
  });

  it("blocks deleting the last definition", async () => {
    const token = await createUser(
      "contract-guard-last@test.com",
      "owner",
      "guard-last",
    );
    const only = await createPipeline(token, {
      name: "Only definition",
      stages: STAGES,
    });
    expect(only.status).toBe(201);
    const response = await request(app)
      .delete(`/api/pipeline-definitions/${only.body.id}`)
      .set(as(token));
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/last pipeline/i);
  });

  it("blocks deleting the default definition", async () => {
    const first = await createPipeline(adminToken, {
      name: "Guarded default",
      isDefault: true,
      stages: STAGES,
    });
    expect(first.status).toBe(201);
    const second = await createPipeline(adminToken, {
      name: "Guarded sibling",
      isDefault: false,
      stages: STAGES,
    });
    expect(second.status).toBe(201);

    const response = await request(app)
      .delete(`/api/pipeline-definitions/${first.body.id}`)
      .set(as(adminToken));
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/default pipeline/i);
  });

  it("blocks deleting a definition referenced by deals", async () => {
    const token = await createUser(
      "contract-guard-deals@test.com",
      "owner",
      "guard-deals",
    );
    const used = await createPipeline(token, {
      name: "Used definition",
      isDefault: false,
      stages: STAGES,
    });
    expect(used.status).toBe(201);
    const spare = await createPipeline(token, {
      name: "Spare definition",
      isDefault: false,
      stages: STAGES,
    });
    expect(spare.status).toBe(201);

    const deal = await request(app)
      .post("/api/deals")
      .set(as(token))
      .send({
        title: "Guarded deal",
        stage: "new",
        pipelineId: used.body.id,
      });
    expect(deal.status).toBe(201);
    expect(deal.body.pipelineId).toBe(used.body.id);

    const response = await request(app)
      .delete(`/api/pipeline-definitions/${used.body.id}`)
      .set(as(token));
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/deal\(s\) still reference it/i);
  });
});
