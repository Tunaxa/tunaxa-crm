import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { closePool, query } from "../db/pg.js";
import { mutateDb } from "../store.js";
import {
  cleanupTestDb,
  loginAs,
  resetTestDb,
  seedTestUser,
} from "./setup.js";

let app;
let adminToken;
let tenantBToken;
let viewerToken;

const STAGES = [
  { key: "new", label: "New", probability: 10, order: 0 },
  { key: "won", label: "Won", probability: 100, order: 1 },
];

async function createUser({ email, role, workspaceId }) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("test123", salt, 64).toString("hex");
  const password = `${salt}:${hash}`;
  await mutateDb((db) => {
    db.users.push({
      id: `usr_${email}`,
      name: email,
      email,
      password,
      role,
      workspaceId,
      createdAt: new Date().toISOString(),
    });
  });
  const response = await request(app)
    .post("/api/auth/login")
    .send({ email, password: "test123" });
  if (response.status !== 200) {
    throw new Error(`login failed for ${email}: ${response.status}`);
  }
  return response.body.token;
}

const as = (token) => ({ Authorization: `Bearer ${token}` });

async function createPipeline(token, body) {
  return request(app)
    .post("/api/pipeline-definitions")
    .set(as(token))
    .send(body);
}

beforeAll(async () => {
  await resetTestDb();
  const module = await import("../server.js");
  app = module.app;
  await seedTestUser();
  adminToken = await loginAs(app);
  tenantBToken = await createUser({
    email: "tenantb@test.com",
    role: "Owner",
    workspaceId: "tenant-b",
  });
  viewerToken = await createUser({
    email: "viewer@test.com",
    role: "viewer",
    workspaceId: "default",
  });
});

afterAll(async () => {
  // The route enforces delete guards; tests clean up at the storage layer so
  // in-use / default definitions can be removed without distorting assertions.
  try {
    await query(
      "DELETE FROM pipeline_definitions WHERE workspace_id IN ('default', 'tenant-b')",
    );
    await query(
      "DELETE FROM deals WHERE workspace_id IN ('default', 'tenant-b')",
    );
  } catch {
    // Postgres is optional in the local harness; the JSON store is cleaned too.
  }
  await mutateDb((db) => {
    db.pipelineDefinitions = (db.pipelineDefinitions || []).filter(
      (p) => !["default", "tenant-b"].includes(p.workspaceId),
    );
    db.deals = (db.deals || []).filter(
      (d) => !["default", "tenant-b"].includes(d.workspaceId),
    );
  });
  await cleanupTestDb();
  await closePool();
});

describe("pipeline definitions - authentication and RBAC", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const response = await request(app).get("/api/pipeline-definitions");
    expect(response.status).toBe(401);
  });

  it("rejects non-admin roles on mutations with 403", async () => {
    const response = await createPipeline(viewerToken, {
      name: "Forbidden",
      stages: STAGES,
    });
    expect(response.status).toBe(403);
  });
});

describe("pipeline definitions - validation", () => {
  it.each([
    ["negative probability", { key: "x", label: "X", probability: -5 }],
    ["probability above 100", { key: "x", label: "X", probability: 150 }],
    ["NaN probability", { key: "x", label: "X", probability: NaN }],
    ["prototype key", { key: "__proto__", label: "X", probability: 10 }],
  ])("rejects %s with 400", async (_label, stage) => {
    const response = await createPipeline(adminToken, {
      name: "Invalid",
      stages: [stage],
    });
    expect(response.status).toBe(400);
  });

  it("rejects duplicate stage keys with 400", async () => {
    const response = await createPipeline(adminToken, {
      name: "Duplicates",
      stages: [
        { key: "same", label: "One", probability: 10 },
        { key: "same", label: "Two", probability: 20 },
      ],
    });
    expect(response.status).toBe(400);
  });

  it("rejects an empty name with 400", async () => {
    const response = await createPipeline(adminToken, {
      name: "   ",
      stages: STAGES,
    });
    expect(response.status).toBe(400);
  });
});

describe("pipeline definitions - CRUD and defaults", () => {
  it("creates, lists, reads, updates, and deletes a definition", async () => {
    const created = await createPipeline(adminToken, {
      name: "Sales Pipeline",
      stages: STAGES,
    });
    expect(created.status).toBe(201);
    expect(created.body).toHaveProperty("id");
    const definitionId = created.body.id;

    const list = await request(app)
      .get("/api/pipeline-definitions")
      .set(as(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.some((p) => p.id === definitionId)).toBe(true);

    const single = await request(app)
      .get(`/api/pipeline-definitions/${definitionId}`)
      .set(as(adminToken));
    expect(single.status).toBe(200);
    expect(single.body.name).toBe("Sales Pipeline");

    const updated = await request(app)
      .put(`/api/pipeline-definitions/${definitionId}`)
      .set(as(adminToken))
      .send({ name: "Enterprise Pipeline" });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("Enterprise Pipeline");

    // A second definition in the SAME tenant is required before deletion is
    // permitted (the last definition in a tenant cannot be deleted).
    const second = await createPipeline(adminToken, {
      name: "Second Pipeline",
      stages: STAGES,
    });
    expect(second.status).toBe(201);

    const removed = await request(app)
      .delete(`/api/pipeline-definitions/${definitionId}`)
      .set(as(adminToken));
    expect(removed.status).toBe(200);
    expect(removed.body.ok).toBe(true);
  });

  it("switches the tenant default when isDefault is set on another definition", async () => {
    const first = await createPipeline(adminToken, {
      name: "Default One",
      isDefault: true,
      stages: STAGES,
    });
    expect(first.status).toBe(201);

    const second = await createPipeline(adminToken, {
      name: "Default Two",
      isDefault: true,
      stages: STAGES,
    });
    expect(second.status).toBe(201);

    const list = await request(app)
      .get("/api/pipeline-definitions")
      .set(as(adminToken));
    const defaults = list.body.filter(
      (p) => p.workspaceId === "default" && p.isDefault,
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(second.body.id);
  });
});

describe("pipeline definitions - tenant isolation", () => {
  let tenantAId;

  beforeAll(async () => {
    const created = await createPipeline(adminToken, {
      name: "Tenant A Private",
      stages: STAGES,
    });
    tenantAId = created.body.id;
  });

  it("returns 404 for cross-tenant read, update, and delete", async () => {
    const read = await request(app)
      .get(`/api/pipeline-definitions/${tenantAId}`)
      .set(as(tenantBToken));
    expect(read.status).toBe(404);

    const update = await request(app)
      .put(`/api/pipeline-definitions/${tenantAId}`)
      .set(as(tenantBToken))
      .send({ name: "Hijacked" });
    expect(update.status).toBe(404);

    const remove = await request(app)
      .delete(`/api/pipeline-definitions/${tenantAId}`)
      .set(as(tenantBToken));
    expect(remove.status).toBe(404);
  });

  it("does not leak other tenants' definitions in the list", async () => {
    const list = await request(app)
      .get("/api/pipeline-definitions")
      .set(as(tenantBToken));
    expect(list.status).toBe(200);
    expect(list.body.some((p) => p.id === tenantAId)).toBe(false);
  });

  it("rejects assigning another tenant's pipelineId to a deal with 404", async () => {
    const deal = await request(app)
      .post("/api/deals")
      .set(as(tenantBToken))
      .send({ title: "Cross-tenant deal", pipelineId: tenantAId });
    expect(deal.status).toBe(404);
  });
});

describe("deal integration", () => {
  it("persists an explicit pipelineId and defaults an omitted one", async () => {
    const pipeline = await createPipeline(adminToken, {
      name: "Deal Integration Default",
      entityType: "deal",
      isDefault: true,
      stages: STAGES,
    });
    expect(pipeline.status).toBe(201);

    const explicit = await request(app)
      .post("/api/deals")
      .set(as(adminToken))
      .send({ title: "Explicit", pipelineId: pipeline.body.id });
    expect(explicit.status).toBe(201);
    expect(explicit.body.pipelineId).toBe(pipeline.body.id);

    const implicit = await request(app)
      .post("/api/deals")
      .set(as(adminToken))
      .send({ title: "Implicit" });
    expect(implicit.status).toBe(201);
    expect(implicit.body.pipelineId).toBe(pipeline.body.id);
  });

  it("returns 409 when deleting a pipeline still referenced by a deal", async () => {
    // A sibling definition is needed so the "last definition" guard does not
    // mask the in-use-by-deal guard we are testing here.
    const sibling = await createPipeline(adminToken, {
      name: "Sibling Pipeline",
      stages: STAGES,
    });
    expect(sibling.status).toBe(201);

    const pipeline = await createPipeline(adminToken, {
      name: "In Use By Deal",
      stages: STAGES,
    });
    expect(pipeline.status).toBe(201);

    const deal = await request(app)
      .post("/api/deals")
      .set(as(adminToken))
      .send({ title: "Linked deal", pipelineId: pipeline.body.id });
    expect(deal.status).toBe(201);
    expect(deal.body.pipelineId).toBe(pipeline.body.id);

    const response = await request(app)
      .delete(`/api/pipeline-definitions/${pipeline.body.id}`)
      .set(as(adminToken));
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/deal\(s\)/);
  });
});
