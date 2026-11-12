// Bulk PATCH / DELETE contracts and their security boundaries.
//
// Every fixture is a real PostgreSQL row, seeded through the same repository
// the route uses. The JSON-store fixtures the first version of this suite
// planted in `db.leads` were never reachable: `leads`, `contacts` and `tasks`
// are all PG-backed, so those tests proved only that a request could 400.
//
// The security cases are the point of the file:
//   - an id from another workspace is reported exactly like a missing one and
//     the row is untouched (cross-tenant IDOR);
//   - `workspaceId`/`workspace_id` and prototype keys are stripped from the
//     delta, so a batch cannot move a record between tenants or reach
//     Object.prototype;
//   - a role with a masked field is refused with 403 before anything is
//     written.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { closePool, query } from "../db/pg.js";
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from "./setup.js";
import { mutateDb } from "../store.js";
import { repoFor } from "../db/repositories/index.js";

let app;
let adminToken;
let memberToken;

const DEFAULT_WS = "default";
const OTHER_WS = "ws_batch_other";

const fixtures = {
  otherLead: null,
  otherContact: null,
  otherTask: null,
  bulkContacts: [],
};

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

// Seeding goes through the repositories so the rows are identical to the ones
// the write path produces (generated id, workspace_id, timestamps).
async function seedLead(overrides = {}, workspaceId = DEFAULT_WS) {
  const row = await repoFor("leads").create({
    workspace_id: workspaceId,
    first_name: "Batch",
    last_name: "Lead",
    email: `lead_${crypto.randomUUID()}@example.com`,
    status: "open",
    value: 1000,
    ...overrides,
  });
  return row.id;
}

async function seedContact(overrides = {}, workspaceId = DEFAULT_WS) {
  const row = await repoFor("contacts").create({
    workspace_id: workspaceId,
    first_name: "Batch",
    last_name: "Contact",
    email: `contact_${crypto.randomUUID()}@example.com`,
    phone: "+1-555-0100",
    ...overrides,
  });
  return row.id;
}

async function seedTask(overrides = {}, workspaceId = DEFAULT_WS) {
  const row = await repoFor("tasks").create({
    workspace_id: workspaceId,
    title: `Batch task ${crypto.randomUUID()}`,
    status: "Open",
    ...overrides,
  });
  return row.id;
}

async function readLead(id) {
  const result = await query("SELECT * FROM leads WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function readContact(id) {
  const result = await query("SELECT * FROM contacts WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function readTask(id) {
  const result = await query("SELECT * FROM tasks WHERE id = $1", [id]);
  return result.rows[0] || null;
}

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;

  await seedTestUser();
  adminToken = await loginAs(app);

  await mutateDb((db) => {
    db.users.push({
      id: "usr_batch_member",
      name: "Batch Member",
      email: "batchmember@test.com",
      password: makePassword(),
      role: "member",
      workspaceId: DEFAULT_WS,
      createdAt: new Date().toISOString(),
    });
    // `phone` is a real contacts column, so the write mask has something
    // concrete to protect.
    db.fieldPermissions = {
      contact: {
        member: { visible: null, hidden: ["phone"] },
      },
    };
  });
  memberToken = await seedSession("usr_batch_member");

  // Cross-tenant rows, one per resource, addressed by the default tenant below.
  fixtures.otherLead = await seedLead({ status: "open" }, OTHER_WS);
  fixtures.otherContact = await seedContact(
    { first_name: "Other", phone: "+1-555-0000" },
    OTHER_WS,
  );
  fixtures.otherTask = await seedTask({ title: "Other tenant task" }, OTHER_WS);

  // Exactly 100 rows, so the upper bound itself is exercised rather than a
  // rejection one past it.
  fixtures.bulkContacts = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      seedContact({ first_name: `Bulk${index + 1}` }),
    ),
  );
}, 60_000);

afterAll(async () => {
  await cleanupTestDb();
  await closePool();
});

const asAdmin = (req) => req.set("Authorization", `Bearer ${adminToken}`);
const asMember = (req) => req.set("Authorization", `Bearer ${memberToken}`);

// ===========================================================================
describe("PATCH /api/:resource/batch - input hygiene", () => {
  it("rejects an empty ids array", async () => {
    const res = await asAdmin(
      request(app)
        .patch("/api/leads/batch")
        .send({ ids: [], data: { status: "qualified" } }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 100/);
  });

  it("rejects more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `missing_${index}`);
    const res = await asAdmin(
      request(app)
        .patch("/api/leads/batch")
        .send({ ids, data: { status: "qualified" } }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 100/);
  });

  it("rejects a non-array ids payload", async () => {
    const res = await asAdmin(
      request(app)
        .patch("/api/leads/batch")
        .send({ ids: "lead_one", data: { status: "qualified" } }),
    );

    expect(res.status).toBe(400);
  });

  it("rejects non-string and blank id elements", async () => {
    for (const ids of [[123], [""], ["   "], [null]]) {
      const res = await asAdmin(
        request(app)
          .patch("/api/leads/batch")
          .send({ ids, data: { status: "qualified" } }),
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/non-empty strings/);
    }
  });

  it("rejects a non-object data payload", async () => {
    const id = await seedLead();
    const res = await asAdmin(
      request(app)
        .patch("/api/leads/batch")
        .send({ ids: [id], data: ["not", "an", "object"] }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/data must be an object/);
  });

  it("deduplicates repeated ids so one record is mutated once", async () => {
    const id = await seedLead({ status: "open" });
    const res = await asAdmin(
      request(app)
        .patch("/api/leads/batch")
        .send({ ids: [id, id, id], data: { status: "qualified" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(1);
    expect(res.body.errorCount).toBe(0);
    expect((await readLead(id)).status).toBe("qualified");
  });

  it("accepts exactly 100 records", async () => {
    const res = await asAdmin(
      request(app)
        .patch("/api/contacts/batch")
        .send({ ids: fixtures.bulkContacts, data: { last_name: "Batched" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(100);
    expect(res.body.errorCount).toBe(0);
    expect((await readContact(fixtures.bulkContacts[0])).last_name).toBe(
      "Batched",
    );
  });

  it("returns 404 for an unknown resource", async () => {
    const res = await asAdmin(
      request(app)
        .patch("/api/not_a_resource/batch")
        .send({ ids: ["x"], data: { status: "open" } }),
    );

    expect(res.status).toBe(404);
  });

  it("returns 404 for a prototype-named resource", async () => {
    for (const resource of ["__proto__", "constructor", "prototype"]) {
      const res = await asAdmin(
        request(app)
          .patch(`/api/${resource}/batch`)
          .send({ ids: ["x"], data: { status: "open" } }),
      );

      expect(res.status).toBe(404);
    }
  });
});

// ===========================================================================
describe("PATCH /api/:resource/batch - updates", () => {
  it("updates every record and persists the delta", async () => {
    const ids = await Promise.all([
      seedLead({ status: "open" }),
      seedLead({ status: "open" }),
      seedLead({ status: "open" }),
    ]);

    const res = await asAdmin(
      request(app)
        .patch("/api/leads/batch")
        .send({ ids, data: { status: "qualified" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(3);
    expect(res.body.errorCount).toBe(0);

    for (const id of ids) {
      expect((await readLead(id)).status).toBe("qualified");
    }
  });

  it("reports partial success with 207", async () => {
    const good = await seedLead();
    const res = await asAdmin(
      request(app)
        .patch("/api/leads/batch")
        .send({
          ids: [good, "missing_one", "missing_two"],
          data: { status: "lost" },
        }),
    );

    expect(res.status).toBe(207);
    expect(res.body.successCount).toBe(1);
    expect(res.body.errorCount).toBe(2);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "missing_one", reason: "Record not found" }),
        expect.objectContaining({ id: "missing_two", reason: "Record not found" }),
      ]),
    );
    expect((await readLead(good)).status).toBe("lost");
  });

  it("returns 400 when every id fails", async () => {
    const res = await asAdmin(
      request(app)
        .patch("/api/leads/batch")
        .send({ ids: ["missing_a", "missing_b"], data: { status: "new" } }),
    );

    expect(res.status).toBe(400);
    expect(res.body.successCount).toBe(0);
    expect(res.body.errorCount).toBe(2);
  });

  it("strips server-owned fields from the delta", async () => {
    const id = await seedLead({ status: "open" });
    const res = await asAdmin(
      request(app)
        .patch("/api/leads/batch")
        .send({
          ids: [id],
          data: {
            status: "closed",
            id: "tampered",
            createdAt: "2020-01-01T00:00:00.000Z",
            updatedAt: "2020-01-01T00:00:00.000Z",
          },
        }),
    );

    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(1);

    const row = await readLead(id);
    expect(row.id).toBe(id);
    expect(row.status).toBe("closed");
    expect(row.created_at.toISOString()).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("leaves the single-record GET route reachable", async () => {
    const id = await seedLead({ first_name: "Direct" });
    const res = await asAdmin(request(app).get(`/api/leads/${id}`));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.first_name).toBe("Direct");
  });
});

// ===========================================================================
describe("PATCH /api/:resource/batch - tenant and prototype safety", () => {
  it("cannot see or update a record from another workspace", async () => {
    const before = await readLead(fixtures.otherLead);
    const res = await asAdmin(
      request(app)
        .patch("/api/leads/batch")
        .send({
          ids: [fixtures.otherLead],
          data: { status: "hijacked" },
        }),
    );

    expect(res.status).toBe(400);
    expect(res.body.successCount).toBe(0);
    expect(res.body.errors).toEqual([
      { id: fixtures.otherLead, reason: "Record not found" },
    ]);

    const after = await readLead(fixtures.otherLead);
    expect(after).toEqual(before);
    expect(after.workspace_id).toBe(OTHER_WS);
    expect(after.status).toBe("open");
  });

  it("reports a cross-tenant id as a partial failure without touching it", async () => {
    const own = await seedLead({ status: "open" });
    const before = await readLead(fixtures.otherLead);

    const res = await asAdmin(
      request(app)
        .patch("/api/leads/batch")
        .send({
          ids: [own, fixtures.otherLead],
          data: { status: "qualified" },
        }),
    );

    expect(res.status).toBe(207);
    expect(res.body.successCount).toBe(1);
    expect(res.body.errorCount).toBe(1);
    expect(res.body.errors).toEqual([
      { id: fixtures.otherLead, reason: "Record not found" },
    ]);
    expect((await readLead(own)).status).toBe("qualified");
    expect(await readLead(fixtures.otherLead)).toEqual(before);
  });

  it("ignores workspaceId, workspace_id and prototype keys in the delta", async () => {
    const id = await seedLead({ status: "open" });
    // Built as a JSON string: an object literal would swallow `__proto__`
    // instead of sending it, while JSON.parse on the server keeps it as an own
    // property - which is exactly the vector a hostile client uses.
    const rest = JSON.stringify({
      status: "qualified",
      workspace_id: OTHER_WS,
      workspaceId: OTHER_WS,
      constructor: { prototype: { polluted: true } },
      prototype: { polluted: true },
    }).slice(1);
    const raw = `{"ids":${JSON.stringify([
      id,
    ])},"data":{"__proto__":{"polluted":true,"workspace_id":"${OTHER_WS}"},${rest}}`;

    const res = await asAdmin(
      request(app)
        .patch("/api/leads/batch")
        .set("Content-Type", "application/json")
        .send(raw),
    );

    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(1);

    const row = await readLead(id);
    expect(row.workspace_id).toBe(DEFAULT_WS);
    expect(row.status).toBe("qualified");
    expect(row.id).toBe(id);
    // None of the stripped keys were smuggled into the overflow bag either.
    expect(Object.keys(row.custom_fields || {})).toEqual([]);

    // The prototype chain is untouched.
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
  });

  it("does not expose other-tenant rows in the list endpoint", async () => {
    const res = await asAdmin(request(app).get("/api/leads?limit=100"));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.map((lead) => lead.id)).not.toContain(
      fixtures.otherLead,
    );
  });
});

// ===========================================================================
describe("PATCH /api/:resource/batch - write field masks", () => {
  it("403s a masked field and leaves the row untouched", async () => {
    const id = await seedContact({ phone: "+1-555-0100" });
    const before = await readContact(id);

    const res = await asMember(
      request(app)
        .patch("/api/contacts/batch")
        .send({ ids: [id], data: { phone: "+1-555-9999" } }),
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden: Cannot write to masked field(s)");
    expect(res.body.maskedFields).toEqual(["phone"]);
    expect(await readContact(id)).toEqual(before);
  });

  it("allows a member to batch-write an unmasked field", async () => {
    const id = await seedContact({ first_name: "Allowed" });

    const res = await asMember(
      request(app)
        .patch("/api/contacts/batch")
        .send({ ids: [id], data: { first_name: "Renamed" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(1);
    expect((await readContact(id)).first_name).toBe("Renamed");
  });

  it("lets an admin write a masked field", async () => {
    const id = await seedContact({ phone: "+1-555-0100" });

    const res = await asAdmin(
      request(app)
        .patch("/api/contacts/batch")
        .send({ ids: [id], data: { phone: "+1-555-0200" } }),
    );

    expect(res.status).toBe(200);
    expect((await readContact(id)).phone).toBe("+1-555-0200");
  });
});

// ===========================================================================
describe("DELETE /api/:resource/batch", () => {
  it("rejects an empty ids array", async () => {
    const res = await asAdmin(
      request(app).delete("/api/leads/batch").send({ ids: [] }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 100/);
  });

  it("rejects more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `missing_${index}`);
    const res = await asAdmin(
      request(app).delete("/api/leads/batch").send({ ids }),
    );

    expect(res.status).toBe(400);
  });

  it("deletes every record", async () => {
    const ids = await Promise.all([seedTask(), seedTask(), seedTask()]);

    const res = await asAdmin(
      request(app)
        .delete("/api/tasks/batch")
        .send({ ids: ids.slice(0, 2) }),
    );

    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(2);
    expect(res.body.errorCount).toBe(0);
    expect(await readTask(ids[0])).toBeNull();
    expect(await readTask(ids[1])).toBeNull();
    expect(await readTask(ids[2])).not.toBeNull();
  });

  it("reports partial success with 207", async () => {
    const doomed = await seedLead();

    const res = await asAdmin(
      request(app)
        .delete("/api/leads/batch")
        .send({ ids: [doomed, "gone_x"] }),
    );

    expect(res.status).toBe(207);
    expect(res.body.successCount).toBe(1);
    expect(res.body.errorCount).toBe(1);
    expect(res.body.errors).toEqual([
      { id: "gone_x", reason: "Record not found" },
    ]);
    expect(await readLead(doomed)).toBeNull();
  });

  it("returns 400 when every id fails", async () => {
    const res = await asAdmin(
      request(app).delete("/api/leads/batch").send({ ids: ["x1", "x2", "x3"] }),
    );

    expect(res.status).toBe(400);
    expect(res.body.successCount).toBe(0);
    expect(res.body.errorCount).toBe(3);
  });

  it("does not delete a record from another workspace", async () => {
    const before = await readLead(fixtures.otherLead);
    const res = await asAdmin(
      request(app)
        .delete("/api/leads/batch")
        .send({ ids: [fixtures.otherLead] }),
    );

    expect(res.status).toBe(400);
    expect(res.body.successCount).toBe(0);
    expect(res.body.errors).toEqual([
      { id: fixtures.otherLead, reason: "Record not found" },
    ]);
    expect(await readLead(fixtures.otherLead)).toEqual(before);
  });

  it("does not delete a contact or task from another workspace", async () => {
    const contactBefore = await readContact(fixtures.otherContact);
    const taskBefore = await readTask(fixtures.otherTask);

    const contactRes = await asAdmin(
      request(app)
        .delete("/api/contacts/batch")
        .send({ ids: [fixtures.otherContact] }),
    );
    const taskRes = await asAdmin(
      request(app)
        .delete("/api/tasks/batch")
        .send({ ids: [fixtures.otherTask] }),
    );

    expect(contactRes.status).toBe(400);
    expect(taskRes.status).toBe(400);
    expect(await readContact(fixtures.otherContact)).toEqual(contactBefore);
    expect(await readTask(fixtures.otherTask)).toEqual(taskBefore);
  });

  it("returns 404 for an unknown or prototype-named resource", async () => {
    for (const resource of ["not_a_resource", "__proto__", "constructor"]) {
      const res = await asAdmin(
        request(app).delete(`/api/${resource}/batch`).send({ ids: ["x"] }),
      );

      expect(res.status).toBe(404);
    }
  });
});
