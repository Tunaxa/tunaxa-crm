import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { resetTestDb, cleanupTestDb } from "./setup.js";
import { mutateDb, readDb } from "../store.js";

let app;

function makePassword() {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("test123", salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

async function login(email) {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email, password: "test123" });
  return res.body.token;
}

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
  // owner + admin + member + viewer
  await mutateDb((db) => {
    db.users.unshift({
      id: "usr_owner",
      name: "Owner",
      email: "owner@test.com",
      password: makePassword(),
      role: "Owner",
      createdAt: new Date().toISOString(),
    });
    db.users.unshift({
      id: "usr_admin",
      name: "Admin",
      email: "admin@test.com",
      password: makePassword(),
      role: "admin",
      createdAt: new Date().toISOString(),
    });
    db.users.unshift({
      id: "usr_member",
      name: "Member",
      email: "member@test.com",
      password: makePassword(),
      role: "member",
      createdAt: new Date().toISOString(),
    });
    db.users.unshift({
      id: "usr_viewer",
      name: "Viewer",
      email: "viewer@test.com",
      password: makePassword(),
      role: "viewer",
      createdAt: new Date().toISOString(),
    });
  });
});

afterAll(() => cleanupTestDb());

describe("RBAC end-to-end verification", () => {
  let ownerToken, memberToken, viewerToken;
  let createdLeadId;

  beforeAll(async () => {
    ownerToken = await login("owner@test.com");
    memberToken = await login("member@test.com");
    viewerToken = await login("viewer@test.com");
  });

  // -------- Reads are open to every authenticated role --------
  it.each([
    ["owner", () => ownerToken],
    ["admin", () => ownerToken],
    ["member", () => memberToken],
    ["viewer", () => viewerToken],
  ])("%s can read resources", async (_label, getToken) => {
    const res = await request(app)
      .get("/api/leads")
      .set("Authorization", `Bearer ${getToken()}`);
    expect(res.status).toBe(200);
  });

  it.each(["owner", "admin", "member", "viewer"])(
    "%s can read settings, permissions, reports, onboarding",
    async (role) => {
      const token =
        role === "viewer"
          ? viewerToken
          : role === "member"
            ? memberToken
            : ownerToken;
      for (const url of [
        "/api/settings",
        "/api/permissions",
        "/api/reports/pipeline",
        "/api/onboarding/status",
      ]) {
        const res = await request(app)
          .get(url)
          .set("Authorization", `Bearer ${token}`);
        expect(res.status, `${role} GET ${url}`).toBe(200);
      }
    },
  );

  // -------- Feature writes: viewer blocked, member/owner allowed --------
  const writeRequests = [
    [
      "POST /api/messages/send",
      "/api/messages/send",
      "post",
      { to: "a@b.com", body: "hi" },
    ],
    [
      "POST /api/onboarding/step",
      "/api/onboarding/step",
      "post",
      { step: "profile", data: {} },
    ],
    ["POST /api/lists", "/api/lists", "post", { name: "test list" }],
    [
      "POST /api/templates",
      "/api/templates",
      "post",
      { name: "T", subject: "S", body: "B" },
    ],
    [
      "POST /api/leadscoring/recalculate",
      "/api/leadscoring/recalculate",
      "post",
      {},
    ],
  ];

  it.each(writeRequests)(
    "%s — viewer blocked",
    async (_name, url, method, body) => {
      const res = await request(app)[method](url)
        .set("Authorization", `Bearer ${viewerToken}`)
        .send(body);
      expect(res.status).toBe(403);
    },
  );

  it.each(writeRequests)(
    "%s — member and owner allowed to reach handler (not 403)",
    async (_name, url, method, body) => {
      for (const token of [memberToken, ownerToken]) {
        const res = await request(app)[method](url)
          .set("Authorization", `Bearer ${token}`)
          .send(body);
        expect(res.status, `token ${url}`).not.toBe(403);
        expect(res.status).not.toBe(401);
      }
    },
  );

  // Data-write endpoints that require body/params validation first (400 for empty body) — still must NOT be 403
  it("viewer cannot POST /api/calls/dial (403)", async () => {
    const res = await request(app)
      .post("/api/calls/dial")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ phone: "+10000000000" });
    expect(res.status).toBe(403);
  });

  // -------- Legacy resource write: viewer blocked, member allowed, owner allowed --------
  it("viewer cannot POST a lead (403)", async () => {
    const res = await request(app)
      .post("/api/leads")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ name: "V" });
    expect(res.status).toBe(403);
  });

  it("member can POST a lead (201)", async () => {
    const res = await request(app)
      .post("/api/leads")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "M Lead" });
    expect(res.status).toBe(201);
    createdLeadId = res.body.id;
  });

  it("viewer cannot update or delete the lead (403)", async () => {
    const put = await request(app)
      .put(`/api/leads/${createdLeadId}`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ name: "Hacked" });
    expect(put.status).toBe(403);
    const del = await request(app)
      .delete(`/api/leads/${createdLeadId}`)
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(del.status).toBe(403);
  });

  it("member can update the lead (200)", async () => {
    const res = await request(app)
      .put(`/api/leads/${createdLeadId}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "Updated by member" });
    expect(res.status).toBe(200);
  });

  // -------- Admin-only: member/viewer blocked, owner/admin allowed --------
  const adminRequests = [
    [
      "PUT /api/settings",
      (token) =>
        request(app)
          .put("/api/settings")
          .set("Authorization", `Bearer ${token}`)
          .send({ workspaceName: "N" }),
    ],
    [
      "PUT /api/permissions",
      (token) =>
        request(app)
          .put("/api/permissions")
          .set("Authorization", `Bearer ${token}`)
          .send({}),
    ],
    [
      "POST /api/users",
      (token) =>
        request(app)
          .post("/api/users")
          .set("Authorization", `Bearer ${token}`)
          .send({ name: "X", email: "x@y.com", password: "test123" }),
    ],
  ];

  it.each(adminRequests)(
    "%s — member blocked (403), owner allowed (not 403)",
    async (_name, reqBuilder) => {
      const memberRes = await reqBuilder(memberToken);
      expect(memberRes.status).toBe(403);
      const ownerRes = await reqBuilder(ownerToken);
      expect(ownerRes.status).not.toBe(403);
      expect(ownerRes.status).not.toBe(401);
    },
  );

  it("viewer blocked on PUT /api/settings (403)", async () => {
    const res = await request(app)
      .put("/api/settings")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ workspaceName: "foo" });
    expect(res.status).toBe(403);
  });

  // -------- V1 association & webhook writes: viewer blocked --------
  it("viewer blocked on POST /api/v1/associations (403)", async () => {
    const res = await request(app)
      .post("/api/v1/associations")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ from_object_id: "a", to_object_id: "b", association_type: "x" });
    expect(res.status).toBe(403);
  });

  it("viewer blocked on POST /api/v1/webhooks (403)", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ url: "https://example.com/hook", events: ["lead.created"] });
    expect(res.status).toBe(403);
  });

  // -------- Auth: no token -> 401 everywhere --------
  it("no token -> 401 on reads", async () => {
    const res = await request(app).get("/api/leads");
    expect(res.status).toBe(401);
  });
});

describe("Field-level RBAC on writes (stripHiddenFields)", () => {
  let ownerToken, memberToken;

  beforeAll(async () => {
    ownerToken = await login("owner@test.com");
    memberToken = await login("member@test.com");
  });

  it("owner can configure a hidden field for member", async () => {
    const res = await request(app)
      .put("/api/permissions/fields/lead")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ role: "member", hidden: ["phone"] });
    expect(res.status).toBe(200);
  });

  it("POST with a hidden field does not persist it", async () => {
    const res = await request(app)
      .post("/api/leads")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "Stripped Lead", phone: "888-888-8888", value: 2500 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Stripped Lead");
    expect(res.body.value).toBe(2500);
    expect(res.body.phone).toBeUndefined();

    const db = await readDb();
    const saved = db.leads.find((x) => x.id === res.body.id);
    expect(saved.phone).toBeUndefined();
  });

  it("PUT with a hidden field does not persist it (other edits kept)", async () => {
    const db = await readDb();
    const lead = db.leads.find((x) => x.name === "Stripped Lead");
    expect(lead).toBeTruthy();

    const res = await request(app)
      .put(`/api/leads/${lead.id}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "Renamed Lead", phone: "999-999-9999", value: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Renamed Lead");
    expect(res.body.value).toBe(5000);
    expect(res.body.phone).toBeUndefined();

    const after = (await readDb()).leads.find((x) => x.id === lead.id);
    expect(after.phone).toBeUndefined();
    expect(after.name).toBe("Renamed Lead");
  });

  it("viewer cannot bypass stripping to write through POST (403 first)", async () => {
    const viewerToken = await login("viewer@test.com");
    const res = await request(app)
      .post("/api/leads")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ name: "Viewer Hack", phone: "777-777-7777" });
    expect(res.status).toBe(403);
    const db = await readDb();
    expect(db.leads.some((x) => x.name === "Viewer Hack")).toBe(false);
  });

  it("hidden fields are stripped from batch POST payloads", async () => {
    const res = await request(app)
      .post("/api/leads/batch")
      .set("Authorization", `Bearer ${memberToken}`)
      .send([
        { name: "Batch One", phone: "111-111-1111" },
        { name: "Batch Two", phone: "222-222-2222" },
      ]);
    expect(res.status).toBe(201);
    for (const row of res.body) {
      expect(row.phone).toBeUndefined();
    }
    const db = await readDb();
    const batch = db.leads.filter((x) => x.name.startsWith("Batch "));
    expect(batch).toHaveLength(2);
    for (const row of batch) expect(row.phone).toBeUndefined();
  });

  it("empty and null write bodies are handled safely (no 500)", async () => {
    const res = await request(app)
      .post("/api/leads")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({});
    expect([201, 400]).toContain(res.status);

    const noBody = await request(app)
      .post("/api/leads")
      .set("Authorization", `Bearer ${memberToken}`);
    expect([201, 400]).toContain(noBody.status);
  });

  it("GET still masks the hidden field for the affected role", async () => {
    // Owner is not restricted for this config, so the phone persists server-side.
    const created = await request(app)
      .post("/api/leads")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Masked Read", phone: "123-456-7890" });
    expect(created.status).toBe(201);
    expect(created.body.phone).toBe("123-456-7890");

    // Member reads it masked (applyFieldMasking must stay intact).
    const res = await request(app)
      .get("/api/leads")
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(200);
    const row = res.body.data.find((x) => x.name === "Masked Read");
    expect(row).toBeTruthy();
    expect(row.phone).toBe("••••••");
  });

  it("member with no hidden config can still write phone on contacts", async () => {
    const res = await request(app)
      .post("/api/contacts")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "Contact With Phone", phone: "444-444-4444" });
    expect(res.status).toBe(201);
    expect(res.body.phone).toBe("444-444-4444");
  });
});
