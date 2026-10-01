import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import http from "node:http";
import { closePool } from "../db/pg.js";
import { resetTestDb, seedTestUser, loginAs } from "./setup.js";
import { hashPassword } from "../helpers.js";
import { broadcast, broadcastToUser } from "../routes/sse.js";

let app, token, httpServer, port;

const now = () => new Date().toISOString();
const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

// Seed a user plus a short-lived purpose:sse session so the stream tests can
// authenticate exactly the way the browser EventSource does (query token).
async function seedScopedUser({ id, email, workspaceId, sseToken }) {
  const { mutateDb } = await import("../store.js");
  await mutateDb((db) => {
    db.users.push({
      id,
      name: id,
      email,
      password: hashPassword("test123"),
      role: "Owner",
      workspaceId,
      createdAt: now(),
    });
    db.sessions.push({
      token: sseToken,
      userId: id,
      purpose: "sse",
      createdAt: now(),
      expiresAt: inAnHour(),
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Open a real SSE connection and parse the event stream into an array.
function openStream(sseToken) {
  const state = { status: undefined, events: [], buffer: "" };
  const req = http.get(
    {
      host: "127.0.0.1",
      port,
      path: `/api/events?token=${encodeURIComponent(sseToken)}`,
      headers: { Accept: "text/event-stream" },
    },
    (res) => {
      state.status = res.statusCode;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        state.buffer += chunk;
        let idx;
        while ((idx = state.buffer.indexOf("\n\n")) !== -1) {
          const block = state.buffer.slice(0, idx);
          state.buffer = state.buffer.slice(idx + 2);
          const ev = {};
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) ev.event = line.slice(6).trim();
            else if (line.startsWith("data:")) ev.data = line.slice(5).trim();
          }
          if (ev.event) state.events.push(ev);
        }
      });
    },
  );
  state.close = () => req.destroy();
  return state;
}

async function waitForEvent(state, name, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = state.events.find((event) => event.event === name);
    if (found) return found;
    await delay(10);
  }
  return null;
}

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);

  await seedScopedUser({
    id: "usr_ws_a",
    email: "a@scoped.test",
    workspaceId: "ws_a",
    sseToken: "sse_token_ws_a",
  });
  await seedScopedUser({
    id: "usr_ws_a2",
    email: "a2@scoped.test",
    workspaceId: "ws_a",
    sseToken: "sse_token_ws_a2",
  });
  await seedScopedUser({
    id: "usr_ws_b",
    email: "b@scoped.test",
    workspaceId: "ws_b",
    sseToken: "sse_token_ws_b",
  });

  httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once("listening", resolve));
  port = httpServer.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
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
    const localPort = typeof addr === "string" ? 0 : (addr?.port ?? 0);
    const status = await new Promise((resolve) => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port: localPort,
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

describe("SSE connection authentication", () => {
  it("rejects an unauthenticated /api/events connection with 401", async () => {
    const res = await request(app)
      .get("/api/events")
      .set("Accept", "text/event-stream");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});

describe("SSE scoped room delivery", () => {
  it("delivers workspace-scoped events only to that workspace", async () => {
    const a = openStream("sse_token_ws_a");
    const b = openStream("sse_token_ws_b");
    try {
      expect(await waitForEvent(a, "connected")).not.toBeNull();
      expect(await waitForEvent(b, "connected")).not.toBeNull();

      const delivered = broadcast(
        "record.created",
        { id: "lead_1" },
        { workspaceId: "ws_a" },
      );
      expect(delivered).toBe(1);
      expect(await waitForEvent(a, "record.created")).not.toBeNull();

      await delay(150); // give a mis-scoped client time to (wrongly) receive it
      expect(b.events.some((event) => event.event === "record.created")).toBe(false);
    } finally {
      a.close();
      b.close();
    }
  });

  it("delivers user-room events only to the targeted user", async () => {
    const a = openStream("sse_token_ws_a");
    const a2 = openStream("sse_token_ws_a2");
    try {
      expect(await waitForEvent(a, "connected")).not.toBeNull();
      expect(await waitForEvent(a2, "connected")).not.toBeNull();

      const delivered = broadcastToUser("usr_ws_a", "notification.created", {
        id: "n_1",
      });
      expect(delivered).toBe(1);
      expect(await waitForEvent(a, "notification.created")).not.toBeNull();

      await delay(150);
      expect(
        a2.events.some((event) => event.event === "notification.created"),
      ).toBe(false);
    } finally {
      a.close();
      a2.close();
    }
  });

  it("never broadcasts events that carry no workspace or user scope", async () => {
    const a = openStream("sse_token_ws_a");
    try {
      expect(await waitForEvent(a, "connected")).not.toBeNull();

      expect(broadcast("global.ping", { secret: true })).toBe(0);
      await delay(120);
      expect(a.events.some((event) => event.event === "global.ping")).toBe(false);
    } finally {
      a.close();
    }
  });
});
