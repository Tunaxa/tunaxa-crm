import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { closePool } from "../db/pg.js";
import { resetTestDb, seedTestUser, loginAs } from "./setup.js";
import { mutateDb } from "../store.js";

let app;
let token;

const setupData = async () => {
  await mutateDb((db) => {
    db.leads = [
      { id: "lead_batch_1", firstName: "A", lastName: "One", email: "a@ex.com", status: "open" },
      { id: "lead_batch_2", firstName: "B", lastName: "Two", email: "b@ex.com", status: "open" },
      { id: "lead_batch_3", firstName: "C", lastName: "Three", email: "c@ex.com", status: "open" },
      { id: "lead_batch_4", firstName: "D", lastName: "Four", email: "d@ex.com", status: "open" },
    ];
    db.contacts = [
      { id: "contact_batch_1", firstName: "C1", email: "c1@ex.com" },
    ];
  });
};

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
  await setupData();
});

afterAll(async () => {
  await closePool();
});

describe("batch PATCH /api/:resource/batch", () => {
  it("enforces the 100-record limit (empty array returns 400)", async () => {
    const res = await request(app)
      .patch("/api/leads/batch")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: [], data: { status: "closed" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 100/);
  });

  it("accepts up to 100 (within bounds returns 200 or 207, not 400)", async () => {
    await mutateDb((db) => {
      db.contacts = Array.from({ length: 105 }, (_, i) => ({
        id: `ct_${i + 1}`,
        email: `ct${i + 1}@ex.com`,
      }));
    });
    const ids = Array.from({ length: 100 }, (_, i) => `ct_${i + 1}`);
    const res = await request(app)
      .patch("/api/contacts/batch")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids, data: { notes: "bulk" } });
    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(100);
    expect(res.body.errorCount).toBe(0);
  });

  it("performs successful bulk update", async () => {
    const res = await request(app)
      .patch("/api/leads/batch")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: ["lead_batch_1", "lead_batch_2", "lead_batch_3"], data: { status: "qualified" } });
    expect([200, 207]).toContain(res.status);
    expect(res.body.successCount).toBe(3);
    expect(res.body.errorCount).toBe(0);
  });

  it("strips immutable fields from data", async () => {
    const res = await request(app)
      .patch("/api/leads/batch")
      .set("Authorization", `Bearer ${token}`)
      .send({
        ids: ["lead_batch_4"],
        data: { status: "closed", id: "tampered", createdAt: "2020-01-01T00:00:00.000Z" },
      });
    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(1);
    const list = await request(app).get("/api/leads").set("Authorization", `Bearer ${token}`);
    const l = list.body.find((x) => x.id === "lead_batch_4");
    expect(l.status).toBe("closed");
    expect(l.id).toBe("lead_batch_4");
    expect(l.createdAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("handles partial success/failure (mixed valid/invalid)", async () => {
    const res = await request(app)
      .patch("/api/leads/batch")
      .set("Authorization", `Bearer ${token}`)
      .send({
        ids: ["lead_batch_1", "nope_1", "nope_2"],
        data: { status: "lost" },
      });
    expect(res.status).toBe(207);
    expect(res.body.successCount).toBe(1);
    expect(res.body.errorCount).toBe(2);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "nope_1", reason: expect.any(String) }),
        expect.objectContaining({ id: "nope_2", reason: expect.any(String) }),
      ]),
    );
  });

  it("returns 400 when all IDs fail", async () => {
    const res = await request(app)
      .patch("/api/leads/batch")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: ["missing_a", "missing_b"], data: { status: "new" } });
    expect(res.status).toBe(400);
    expect(res.body.successCount).toBe(0);
    expect(res.body.errorCount).toBe(2);
  });

  it("validates data is an object", async () => {
    const res = await request(app)
      .patch("/api/leads/batch")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: ["lead_batch_1"], data: ["not", "object"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/data must be an object/);
  });
});

describe("batch DELETE /api/:resource/batch", () => {
  it("enforces 1-100 limit", async () => {
    const res = await request(app)
      .delete("/api/leads/batch")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 100/);
  });

  it("deletes in bulk", async () => {
    await mutateDb((db) => {
      db.tasks = [
        { id: "task_b1", title: "t1" },
        { id: "task_b2", title: "t2" },
        { id: "task_b3", title: "t3" },
      ];
    });
    const res = await request(app)
      .delete("/api/tasks/batch")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: ["task_b1", "task_b2"] });
    expect([200, 207]).toContain(res.status);
    expect(res.body.successCount).toBe(2);
    expect(res.body.errorCount).toBe(0);
  });

  it("handles mixed success/failure for delete", async () => {
    const res = await request(app)
      .delete("/api/leads/batch")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: ["lead_batch_3", "gone_x"] });
    expect(res.status).toBe(207);
    expect(res.body.successCount).toBe(1);
    expect(res.body.errorCount).toBe(1);
  });

  it("returns 400 when all fail", async () => {
    const res = await request(app)
      .delete("/api/leads/batch")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: ["x1", "x2", "x3"] });
    expect(res.status).toBe(400);
    expect(res.body.successCount).toBe(0);
    expect(res.body.errorCount).toBe(3);
  });
});
