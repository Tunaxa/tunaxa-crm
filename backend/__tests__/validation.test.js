import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from "./setup.js";

let app;
let token;

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
});

afterAll(() => cleanupTestDb());

describe("Input validation", () => {
  it("POST /api/auth/login rejects body without email", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ password: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it("POST /api/auth/login rejects body without password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "x@x.com" });
    expect(res.status).toBe(400);
  });

  it("POST /api/leads rejects array body", async () => {
    const res = await request(app)
      .post("/api/leads")
      .set("Authorization", `Bearer ${token}`)
      .send([1, 2, 3]);
    expect(res.status).toBe(400);
  });

  it("PUT /api/leads/lead_x rejects array body", async () => {
    const res = await request(app)
      .put("/api/leads/lead_x")
      .set("Authorization", `Bearer ${token}`)
      .send([1, 2, 3]);
    expect(res.status).toBe(400);
  });

  it("POST /api/messages/send rejects missing to", async () => {
    const res = await request(app)
      .post("/api/messages/send")
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Hello" });
    expect(res.status).toBe(400);
  });

  it("POST /api/messages/send rejects missing body", async () => {
    const res = await request(app)
      .post("/api/messages/send")
      .set("Authorization", `Bearer ${token}`)
      .send({ to: "test@test.com" });
    expect(res.status).toBe(400);
  });
});

describe("Settings", () => {
  it("GET /api/settings returns defaults", async () => {
    const res = await request(app)
      .get("/api/settings")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.workspaceName).toBe("Tunaxa");
    expect(res.body.ollamaBaseUrl).toBe("http://localhost:11434");
  });

  it("PUT /api/settings updates workspace name", async () => {
    const res = await request(app)
      .put("/api/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ workspaceName: "My CRM" });
    expect(res.status).toBe(200);
    expect(res.body.workspaceName).toBe("My CRM");
  });
});

const EMPTY_SEARCH_GROUPS = {
  leads: [],
  contacts: [],
  companies: [],
  deals: [],
  tasks: [],
  recordings: [],
};

describe("Search", () => {
  it("GET /api/search with empty q returns empty groups", async () => {
    const res = await request(app)
      .get("/api/search?q=")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(EMPTY_SEARCH_GROUPS);
  });

  it("GET /api/search without q returns empty groups", async () => {
    const res = await request(app)
      .get("/api/search")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(EMPTY_SEARCH_GROUPS);
  });

  it("GET /api/search groups results by entity type", async () => {
    await request(app)
      .post("/api/leads")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Nova Industries",
        company: "Nova",
        email: "nova@example.com",
      })
      .expect(201);
    await request(app)
      .post("/api/contacts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Nova Employee",
        company: "Nova",
        email: "nova-emp@example.com",
      })
      .expect(201);
    await request(app)
      .post("/api/companies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Nova Holdings", industry: "Nova", country: "US" })
      .expect(201);

    const res = await request(app)
      .get("/api/search?q=Nova")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    for (const key of Object.keys(EMPTY_SEARCH_GROUPS))
      expect(Array.isArray(res.body[key])).toBe(true);
    expect(res.body.leads.length).toBeGreaterThan(0);
    expect(res.body.contacts.length).toBeGreaterThan(0);
    expect(res.body.companies.length).toBeGreaterThan(0);
    expect(res.body.leads[0]).toMatchObject({ type: "Lead", route: "/leads" });
    expect(res.body.contacts[0]).toMatchObject({
      type: "Contact",
      route: "/contacts",
    });
    expect(res.body.companies[0]).toMatchObject({
      type: "Company",
      route: "/companies",
    });
  });

  it("GET /api/search matches only configured fields", async () => {
    const created = await request(app)
      .post("/api/leads")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Quiet Zed", email: "zed@example.com", status: "zz-hidden" })
      .expect(201);
    // The marker lives in a field (status) that is not part of the search spec.
    expect(created.body.status).toBe("zz-hidden");

    const res = await request(app)
      .get("/api/search?q=zz-hidden")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.leads).toEqual([]);

    const byName = await request(app)
      .get("/api/search?q=zed")
      .set("Authorization", `Bearer ${token}`);
    expect(byName.status).toBe(200);
    expect(byName.body.leads.length).toBe(1);
    expect(byName.body.leads[0].name).toBe("Quiet Zed");
  });

  it("GET /api/leads?q= filters leads by meaningful fields", async () => {
    await request(app)
      .post("/api/leads")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Zed Zielinski", email: "zed@example.com" })
      .expect(201);
    await request(app)
      .post("/api/leads")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ruth Ramos", email: "ruth@example.com" })
      .expect(201);

    const byName = await request(app)
      .get("/api/leads?q=Zielinski")
      .set("Authorization", `Bearer ${token}`);
    expect(byName.status).toBe(200);
    expect(byName.body).toHaveLength(1);
    expect(byName.body[0].name).toBe("Zed Zielinski");

    const byStatus = await request(app)
      .get("/api/leads?q=zz-hidden")
      .set("Authorization", `Bearer ${token}`);
    expect(byStatus.status).toBe(200);
    expect(byStatus.body).toHaveLength(0);
  });
});

describe("Dashboard", () => {
  it("GET /api/dashboard returns stats", async () => {
    const res = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.leads).toBe("number");
    expect(typeof res.body.contacts).toBe("number");
    expect(typeof res.body.deals).toBe("number");
    expect(Array.isArray(res.body.recent)).toBe(true);
  });
});

describe("Schema", () => {
  it("GET /api/schema/leads returns fields", async () => {
    const res = await request(app)
      .get("/api/schema/leads")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("leads");
    expect(Array.isArray(res.body.fields)).toBe(true);
    expect(res.body.fields.length).toBeGreaterThan(0);
  });

  it("GET /api/schema/unknown returns 404", async () => {
    const res = await request(app)
      .get("/api/schema/unknown")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("Workflows meta", () => {
  it("GET /api/workflows/meta returns events and actions", async () => {
    const res = await request(app)
      .get("/api/workflows/meta")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(Array.isArray(res.body.actions)).toBe(true);
  });
});
