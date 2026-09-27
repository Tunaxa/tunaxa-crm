import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import http from "node:http";
import { closePool } from "../db/pg.js";
import { resetTestDb, seedTestUser, loginAs } from "./setup.js";

let app, token;

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
});

afterAll(async () => {
  await closePool();
});

describe("SSE auth scoping", () => {
  it("mints a short-lived purpose:sse token via header auth", async () => {
    const res = await request(app)
      .post("/api/auth/events-token")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();
  });

  it("rejects events-token without auth", async () => {
    const res = await request(app).post("/api/auth/events-token");
    expect(res.status).toBe(401);
  });

  it("accepts purpose:sse token as query param on /api/events", async () => {
    const minted = await request(app)
      .post("/api/auth/events-token")
      .set("Authorization", `Bearer ${token}`);
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "string" ? 0 : (addr?.port ?? 0);
    const status = await new Promise((resolve) => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port,
          path: `/api/events?token=${minted.body.token}`,
          headers: { Accept: "text/event-stream" },
        },
        (res) => {
          res.destroy();
          resolve(res.statusCode);
        },
      );
      req.on("error", () => resolve(undefined));
    });
    server.close();
    expect(status).toBe(200);
  });

  it("rejects a REGULAR session token as query param on /api/events", async () => {
    const res = await request(app)
      .get(`/api/events?token=${token}`)
      .set("Accept", "text/event-stream");
    expect(res.status).toBe(401);
  });

  it("still accepts header auth on /api/events/clients", async () => {
    const res = await request(app)
      .get("/api/events/clients")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});