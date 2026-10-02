import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { closePool } from "../db/pg.js";
import { resetTestDb, seedTestUser, loginAs } from "./setup.js";

// Intercept SSE broadcasts so we can assert the frontend refresh signal fires.
// The default export is kept real so the SSE HTTP route still registers.
const { broadcastSpy } = vi.hoisted(() => ({ broadcastSpy: vi.fn() }));
vi.mock("../routes/sse.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, broadcast: (...args) => broadcastSpy(...args) };
});

let app, token, viewerToken;
let contactA, contactB, contactC, contactD, contactE, contactF, contactG, contactH, dealA;

const auth = () => ({ Authorization: `Bearer ${token}` });
const viewerAuth = () => ({ Authorization: `Bearer ${viewerToken}` });

async function seedUserWithRole(role, email) {
  const { mutateDb } = await import("../store.js");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("test123", salt, 64).toString("hex");
  const stamp = new Date().toISOString();
  await mutateDb((db) => {
    db.users.push({
      id: `usr_${role}`,
      name: `${role} user`,
      email,
      password: `${salt}:${hash}`,
      role,
      createdAt: stamp,
    });
  });
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email, password: "test123" });
  return res.body.token;
}

// Create a contact through the public API so the fixtures match real records.
async function makeContact(name, email) {
  const res = await request(app)
    .post("/api/contacts")
    .set(auth())
    .send({ name, email, phone: "+21650000000", company: "Acme Corp" });
  expect(res.status).toBe(201);
  return res.body.id;
}

// Give a record a starting stage without going through the endpoint under test,
// so each scenario is independent of the forward-only ordering rule.
async function seedStage(recordId, stage) {
  const { mutateDb } = await import("../store.js");
  await mutateDb((db) => {
    const row = db.contacts.find((c) => c.id === recordId);
    if (row) row.lifecycleStage = stage;
  });
}

async function readDbNow() {
  const { readDb } = await import("../store.js");
  return readDb();
}

async function findContact(recordId) {
  const db = await readDbNow();
  return db.contacts.find((c) => c.id === recordId);
}

async function activitiesFor(recordId) {
  const db = await readDbNow();
  return db.activities.filter((a) => a.recordId === recordId);
}

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
  viewerToken = await seedUserWithRole("viewer", "viewer@test.com");

  contactA = await makeContact("Lifecycle Alpha", "alpha@corp.com");
  contactB = await makeContact("Lifecycle Beta", "beta@corp.com");
  contactC = await makeContact("Lifecycle Gamma", "gamma@corp.com");
  contactD = await makeContact("Lifecycle Delta", "delta@corp.com");
  contactE = await makeContact("Lifecycle Epsilon", "epsilon@corp.com");
  contactF = await makeContact("Lifecycle Zeta", "zeta@corp.com");
  contactG = await makeContact("Lifecycle Eta", "eta@corp.com");
  contactH = await makeContact("Lifecycle Theta", "theta@corp.com");

  // A collection that exists in the store but is not a registered resource.
  // Proves the endpoint gates on the `resources` allowlist rather than merely
  // happening to 404 because the id lookup misses.
  const { mutateDb } = await import("../store.js");
  await mutateDb((db) => {
    db.wombats = [
      { id: "wombat_1", name: "Reggie", lifecycleStage: "Lead", createdAt: new Date().toISOString() },
    ];
  });

  const deal = await request(app)
    .post("/api/deals")
    .set(auth())
    .send({
      title: "Lifecycle Deal",
      company: "Acme Corp",
      value: 42000,
      stage: "New",
      closeDate: "",
    });
  expect(deal.status).toBe(201);
  dealA = deal.body.id;

  await seedStage(contactD, "Lead");
  await seedStage(contactE, "Customer");
}, 60_000);

afterAll(async () => {
  await closePool();
});

describe("GET /api/lifecycle/stages", () => {
  it("returns the configured pipeline stages", async () => {
    const res = await request(app).get("/api/lifecycle/stages").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.stages).toHaveLength(7);
  });

  it("exposes key, label and order metadata per stage", async () => {
    const res = await request(app).get("/api/lifecycle/stages").set(auth());
    expect(res.status).toBe(200);
    for (const stage of res.body.stages) {
      expect(typeof stage.key).toBe("string");
      expect(typeof stage.label).toBe("string");
      expect(typeof stage.order).toBe("number");
    }
  });

  it("orders stages by their position in the pipeline", async () => {
    const res = await request(app).get("/api/lifecycle/stages").set(auth());
    const orders = res.body.stages.map((s) => s.order);
    expect(orders).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(res.body.stages.map((s) => s.stage)).toEqual([
      "Subscriber",
      "Lead",
      "MQL",
      "SQL",
      "Opportunity",
      "Customer",
      "Evangelist",
    ]);
  });

  it("uses the stage itself as the stable key", async () => {
    const res = await request(app).get("/api/lifecycle/stages").set(auth());
    res.body.stages.forEach((s) => expect(s.key).toBe(s.stage));
  });

  it("spells out acronym stages in the label", async () => {
    const res = await request(app).get("/api/lifecycle/stages").set(auth());
    const labels = Object.fromEntries(res.body.stages.map((s) => [s.stage, s.label]));
    expect(labels.MQL).toBe("Marketing Qualified Lead");
    expect(labels.SQL).toBe("Sales Qualified Lead");
    expect(labels.Lead).toBe("Lead");
  });

  it("still reports a per-stage record count", async () => {
    const res = await request(app).get("/api/lifecycle/stages").set(auth());
    res.body.stages.forEach((s) => expect(typeof s.count).toBe("number"));
  });

  it("still returns requiredByStage", async () => {
    const res = await request(app).get("/api/lifecycle/stages").set(auth());
    expect(res.body.requiredByStage).toBeTypeOf("object");
    expect(res.body.requiredByStage.SQL).toEqual(["email", "phone"]);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/lifecycle/stages");
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/:resource/:id/lifecycle - stage update", () => {
  it("sets the lifecycle stage on a record", async () => {
    const res = await request(app)
      .patch(`/api/contacts/${contactA}/lifecycle`)
      .set(auth())
      .send({ stage: "MQL" });
    expect(res.status).toBe(200);
    expect(res.body.lifecycleStage).toBe("MQL");
  });

  it("persists the stage to the store", async () => {
    const contact = await findContact(contactA);
    expect(contact.lifecycleStage).toBe("MQL");
  });

  it("stamps lifecycleUpdatedAt alongside updatedAt", async () => {
    const res = await request(app)
      .patch(`/api/contacts/${contactB}/lifecycle`)
      .set(auth())
      .send({ stage: "SQL" });
    expect(res.status).toBe(200);
    expect(res.body.lifecycleUpdatedAt).toBeTruthy();
    expect(res.body.updatedAt).toBe(res.body.lifecycleUpdatedAt);
  });

  it("moves updatedAt forward", async () => {
    const before = await findContact(contactC);
    expect(before.updatedAt).toBeTruthy();
    const res = await request(app)
      .patch(`/api/contacts/${contactC}/lifecycle`)
      .set(auth())
      .send({ stage: "Lead" });
    expect(res.status).toBe(200);
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.updatedAt).getTime(),
    );
  });

  it("leaves the rest of the record untouched", async () => {
    const before = await findContact(contactG);
    const res = await request(app)
      .patch(`/api/contacts/${contactG}/lifecycle`)
      .set(auth())
      .send({ stage: "Lead" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(before.name);
    expect(res.body.email).toBe(before.email);
    expect(res.body.phone).toBe(before.phone);
    expect(res.body.company).toBe(before.company);
    expect(res.body.id).toBe(contactG);
  });

  it("works for a resource other than contacts", async () => {
    const res = await request(app)
      .patch(`/api/deals/${dealA}/lifecycle`)
      .set(auth())
      .send({ stage: "Opportunity" });
    expect(res.status).toBe(200);
    expect(res.body.lifecycleStage).toBe("Opportunity");
    const db = await readDbNow();
    expect(db.deals.find((d) => d.id === dealA).lifecycleStage).toBe("Opportunity");
  });

  it("does not require the lead/contact stage field prerequisites", async () => {
    // contactF carries no phone, so SQL would be rejected by
    // POST /api/lifecycle/transition. The generic endpoint only validates the stage.
    const res = await request(app)
      .patch(`/api/contacts/${contactF}/lifecycle`)
      .set(auth())
      .send({ stage: "SQL" });
    expect(res.status).toBe(200);
    expect(res.body.lifecycleStage).toBe("SQL");
  });

  it("accepts a forward move from an existing stage", async () => {
    const res = await request(app)
      .patch(`/api/contacts/${contactD}/lifecycle`)
      .set(auth())
      .send({ stage: "MQL" });
    expect(res.status).toBe(200);
    expect(res.body.lifecycleStage).toBe("MQL");
  });

  it("accepts re-sending the current stage", async () => {
    const res = await request(app)
      .patch(`/api/contacts/${contactD}/lifecycle`)
      .set(auth())
      .send({ stage: "MQL" });
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/:resource/:id/lifecycle - activity and audit log", () => {
  it("writes exactly one activity entry linked to the record", async () => {
    const before = await activitiesFor(contactC);
    const res = await request(app)
      .patch(`/api/contacts/${contactC}/lifecycle`)
      .set(auth())
      .send({ stage: "MQL" });
    expect(res.status).toBe(200);
    const entries = await activitiesFor(contactC);
    expect(entries).toHaveLength(before.length + 1);
    expect(entries[0].type).toBe("Lifecycle");
    expect(entries[0].recordId).toBe(contactC);
  });

  it("documents the transition on the activity entry", async () => {
    await request(app)
      .patch(`/api/contacts/${contactC}/lifecycle`)
      .set(auth())
      .send({ stage: "SQL" });
    const entries = await activitiesFor(contactC);
    const latest = entries[0];
    expect(latest.notes).toBe("Lifecycle stage changed to SQL");
    expect(latest.title).toBe("Lifecycle \u2192 SQL");
  });

  it("prepends the activity so the newest change is first", async () => {
    const db = await readDbNow();
    const idx = db.activities.findIndex((a) => a.recordId === contactC);
    expect(idx).toBe(0);
    expect(db.activities[idx].notes).toBe("Lifecycle stage changed to SQL");
  });

  it("keeps a history entry per transition", async () => {
    const entries = await activitiesFor(contactC);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries[0].notes).toBe("Lifecycle stage changed to SQL");
    expect(entries[entries.length - 1].notes).toBe("Lifecycle stage changed to Lead");
  });

  it("carries a date so the timeline can bucket it", async () => {
    const entries = await activitiesFor(contactC);
    expect(entries[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entries[0].createdAt).toBeTruthy();
  });

  it("writes an audit entry naming the actor and record", async () => {
    const db = await readDbNow();
    const entry = db.audit.find((a) => a.action === "Lifecycle stage changed to MQL");
    expect(entry).toBeTruthy();
    expect(entry.actor).toBe("Test User");
    expect(entry.resourceId).toBe(contactC);
  });

  it("does not write an audit entry when the stage is rejected", async () => {
    const before = (await readDbNow()).audit.length;
    const res = await request(app)
      .patch(`/api/contacts/${contactE}/lifecycle`)
      .set(auth())
      .send({ stage: "Lead" });
    expect(res.status).toBe(400);
    expect((await readDbNow()).audit.length).toBe(before);
  });

  it("does not write an activity entry when the stage is rejected", async () => {
    const before = await activitiesFor(contactE);
    await request(app)
      .patch(`/api/contacts/${contactE}/lifecycle`)
      .set(auth())
      .send({ stage: "Lead" });
    expect(await activitiesFor(contactE)).toHaveLength(before.length);
  });
});

describe("PATCH /api/:resource/:id/lifecycle - realtime signal", () => {
  it("broadcasts lifecycle.transitioned with the record and stage", async () => {
    broadcastSpy.mockClear();
    const res = await request(app)
      .patch(`/api/contacts/${contactH}/lifecycle`)
      .set(auth())
      .send({ stage: "MQL" });
    expect(res.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const [event, data] = broadcastSpy.mock.calls[0];
    expect(event).toBe("lifecycle.transitioned");
    expect(data).toEqual({ resource: "contacts", recordId: contactH, stage: "MQL" });
  });

  it("does not broadcast when the stage is rejected", async () => {
    broadcastSpy.mockClear();
    const res = await request(app)
      .patch(`/api/contacts/${contactE}/lifecycle`)
      .set(auth())
      .send({ stage: "Lead" });
    expect(res.status).toBe(400);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/:resource/:id/lifecycle - error handling", () => {
  it("rejects an unknown stage with 400", async () => {
    const res = await request(app)
      .patch(`/api/contacts/${contactA}/lifecycle`)
      .set(auth())
      .send({ stage: "Champion" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("stage must be one of");
  });

  it("is case-sensitive about the stage", async () => {
    const res = await request(app)
      .patch(`/api/contacts/${contactA}/lifecycle`)
      .set(auth())
      .send({ stage: "mql" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing stage with 400", async () => {
    const res = await request(app)
      .patch(`/api/contacts/${contactA}/lifecycle`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("stage is required");
  });

  it("rejects an empty body with 400", async () => {
    const res = await request(app).patch(`/api/contacts/${contactA}/lifecycle`).set(auth());
    expect(res.status).toBe(400);
  });

  it("blocks a backward move with 400", async () => {
    const res = await request(app)
      .patch(`/api/contacts/${contactE}/lifecycle`)
      .set(auth())
      .send({ stage: "Lead" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Cannot move from Customer back to Lead");
  });

  it("leaves the record untouched after a rejected backward move", async () => {
    const contact = await findContact(contactE);
    expect(contact.lifecycleStage).toBe("Customer");
  });

  it("returns 404 for a missing record", async () => {
    const res = await request(app)
      .patch("/api/contacts/contact_does_not_exist/lifecycle")
      .set(auth())
      .send({ stage: "Lead" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Record not found");
  });

  it("returns 404 for an unknown resource", async () => {
    const res = await request(app)
      .patch("/api/wombats/wombat_1/lifecycle")
      .set(auth())
      .send({ stage: "Lead" });
    expect(res.status).toBe(404);
  });

  it("refuses a collection that exists but is not a registered resource", async () => {
    // db.wombats holds wombat_1, so an unguarded handler would find the record
    // and return 200. The resources allowlist has to reject it first.
    const before = await readDbNow();
    expect(before.wombats.find((w) => w.id === "wombat_1")).toBeTruthy();
    const res = await request(app)
      .patch("/api/wombats/wombat_1/lifecycle")
      .set(auth())
      .send({ stage: "Customer" });
    expect(res.status).toBe(404);
    const after = await readDbNow();
    expect(after.wombats.find((w) => w.id === "wombat_1").lifecycleStage).toBe("Lead");
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .patch(`/api/contacts/${contactA}/lifecycle`)
      .send({ stage: "Lead" });
    expect(res.status).toBe(401);
  });

  it("forbids a read-only role", async () => {
    const res = await request(app)
      .patch(`/api/contacts/${contactA}/lifecycle`)
      .set(viewerAuth())
      .send({ stage: "Lead" });
    expect(res.status).toBe(403);
  });
});
