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

describe("Search", () => {
  it("GET /api/search with empty q returns empty", async () => {
    const res = await request(app)
      .get("/api/search?q=")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /api/search without q returns empty", async () => {
    const res = await request(app)
      .get("/api/search")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
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
