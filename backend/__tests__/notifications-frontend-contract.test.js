import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import http from "node:http";
import { cleanupTestDb, resetTestDb } from "./setup.js";
import { closePool } from "../db/pg.js";
import {
  createUserNotification,
  isSafeNotificationLink,
} from "../services/notifications.js";

const workspaceId = "ws_notifications";
const foreignWorkspaceId = "ws_foreign";
let app;
let httpServer;
let port;
let tokens = {};

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openStream(sseToken) {
  const state = { events: [], buffer: "" };
  const req = http.get(
    {
      host: "127.0.0.1",
      port,
      path: `/api/events?token=${encodeURIComponent(sseToken)}`,
      headers: { Accept: "text/event-stream" },
    },
    (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        state.buffer += chunk;
        let index;
        while ((index = state.buffer.indexOf("\n\n")) !== -1) {
          const block = state.buffer.slice(0, index);
          state.buffer = state.buffer.slice(index + 2);
          const event = {};
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event.event = line.slice(6).trim();
            if (line.startsWith("data:")) event.data = line.slice(5).trim();
          }
          if (event.event) state.events.push(event);
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
  app = (await import("../server.js")).app;
  httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once("listening", resolve));
  port = httpServer.address().port;
});

beforeEach(async () => {
  await resetTestDb();
  const { mutateDb } = await import("../store.js");
  await mutateDb((db) => {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    for (const [id, role, tenant] of [
      ["n_owner", "owner", workspaceId],
      ["n_owner_upper", "Owner", workspaceId],
      ["n_admin", "admin", workspaceId],
      ["n_member", "member", workspaceId],
      ["n_viewer", "viewer", workspaceId],
      ["n_foreign", "Owner", foreignWorkspaceId],
    ]) {
      db.users.push({
        id,
        name: id,
        email: `${id}@example.com`,
        role,
        workspaceId: tenant,
        createdAt: now,
      });
      db.sessions.push({
        token: `token_${id}`,
        userId: id,
        createdAt: now,
        expiresAt,
      });
      db.sessions.push({
        token: `sse_${id}`,
        userId: id,
        purpose: "sse",
        createdAt: now,
        expiresAt,
      });
    }
  });
  tokens = {
    owner: "token_n_owner",
    ownerUpper: "token_n_owner_upper",
    admin: "token_n_admin",
    member: "token_n_member",
    viewer: "token_n_viewer",
    foreign: "token_n_foreign",
  };
  await createUserNotification({
    id: "notif_owner_1",
    userId: "n_owner",
    workspaceId,
    title: "Owner one",
    message: "First",
    link: "/contacts/c_1",
    createdAt: "2026-11-25T10:00:00Z",
  });
  await createUserNotification({
    id: "notif_owner_2",
    userId: "n_owner",
    workspaceId,
    title: "Owner two",
    createdAt: "2026-11-26T10:00:00Z",
  });
  await createUserNotification({
    id: "notif_member_1",
    userId: "n_member",
    workspaceId,
    title: "Member one",
    createdAt: "2026-11-26T11:00:00Z",
  });
  await createUserNotification({
    id: "notif_owner_upper",
    userId: "n_owner_upper",
    workspaceId,
    title: "Owner upper",
  });
  await createUserNotification({
    id: "notif_admin",
    userId: "n_admin",
    workspaceId,
    title: "Admin one",
  });
  await createUserNotification({
    id: "notif_owner_foreign",
    userId: "n_owner",
    workspaceId: foreignWorkspaceId,
    title: "Foreign owner",
    createdAt: "2026-11-26T12:00:00Z",
  });
  await createUserNotification({
    id: "notif_foreign_user",
    userId: "n_foreign",
    workspaceId,
    title: "Other user",
    createdAt: "2026-11-26T13:00:00Z",
  });
});

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  await cleanupTestDb();
  await closePool();
});

describe("notification contract", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(401);
  });

  it("lists only the current user and workspace with the expected envelope", async () => {
    const res = await request(app)
      .get("/api/notifications?limit=50&offset=0&unreadOnly=false")
      .set(auth(tokens.owner));
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(2);
    expect(res.body.total).toBe(2);
    expect(res.body.notifications.map((item) => item.id)).toEqual([
      "notif_owner_2",
      "notif_owner_1",
    ]);
    expect(JSON.stringify(res.body)).not.toContain("notif_member_1");
    expect(JSON.stringify(res.body)).not.toContain("notif_owner_foreign");
    expect(JSON.stringify(res.body)).not.toContain("notif_foreign_user");
  });

  it("filters unread rows while keeping the workspace unread count", async () => {
    await request(app)
      .patch("/api/notifications/notif_owner_1/read")
      .set(auth(tokens.owner));
    const res = await request(app)
      .get("/api/notifications?unreadOnly=true")
      .set(auth(tokens.owner));
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.total).toBe(1);
    expect(res.body.notifications.map((item) => item.id)).toEqual([
      "notif_owner_2",
    ]);
  });

  it("rejects invalid list controls", async () => {
    for (const query of ["limit=0", "offset=-1", "unreadOnly=yes"]) {
      const res = await request(app)
        .get(`/api/notifications?${query}`)
        .set(auth(tokens.owner));
      expect(res.status).toBe(400);
    }
  });

  it("stores only validated internal links", () => {
    expect(isSafeNotificationLink("/contacts/c_1")).toBe(true);
    for (const value of [
      "//evil.example",
      "javascript:alert(1)",
      "/contacts/%2fother",
      "/ticket/t_1",
    ]) {
      expect(isSafeNotificationLink(value)).toBe(false);
    }
  });
});

describe("notification isolation and RBAC", () => {
  it("allows owner, Owner, admin and member to mark a scoped notification read", async () => {
    for (const [role, id] of [
      ["owner", "notif_owner_1"],
      ["ownerUpper", "notif_owner_upper"],
      ["admin", "notif_admin"],
      ["member", "notif_member_1"],
    ]) {
      const res = await request(app)
        .patch(`/api/notifications/${id}/read`)
        .set(auth(tokens[role]));
      expect(res.status).toBe(200);
      expect(res.body.read).toBe(true);
    }
  });

  it("denies viewer writes and allows viewer reads", async () => {
    const list = await request(app)
      .get("/api/notifications")
      .set(auth(tokens.viewer));
    expect(list.status).toBe(200);
    const patch = await request(app)
      .patch("/api/notifications/notif_owner_1/read")
      .set(auth(tokens.viewer));
    expect(patch.status).toBe(403);
    const all = await request(app)
      .post("/api/notifications/read-all")
      .set(auth(tokens.viewer));
    expect(all.status).toBe(403);
  });

  it("returns 404 for cross-user and cross-workspace notification ids", async () => {
    for (const id of ["notif_member_1", "notif_owner_foreign", "notif_foreign_user"]) {
      const res = await request(app)
        .patch(`/api/notifications/${id}/read`)
        .set(auth(tokens.owner));
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Notification not found");
    }
  });

  it("rejects prototype-pollution ids", async () => {
    for (const id of ["__proto__", "constructor", "prototype"]) {
      const res = await request(app)
        .patch(`/api/notifications/${id}/read`)
        .set(auth(tokens.owner));
      expect(res.status).toBe(400);
    }
  });

  it("marks only the caller's workspace unread rows as read", async () => {
    const res = await request(app)
      .post("/api/notifications/read-all")
      .set(auth(tokens.member));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 1 });
    const list = await request(app)
      .get("/api/notifications")
      .set(auth(tokens.member));
    expect(list.body.unreadCount).toBe(0);
    const owner = await request(app)
      .get("/api/notifications")
      .set(auth(tokens.owner));
    expect(owner.body.unreadCount).toBe(2);
  });

  it("returns workspace-scoped mention suggestions without credentials", async () => {
    const res = await request(app)
      .get("/api/notifications/mentionable?q=member")
      .set(auth(tokens.owner));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: "n_member", name: "n_member", email: "n_member@example.com" },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("password");
    expect(JSON.stringify(res.body)).not.toContain("n_foreign");
  });
});

describe("notification SSE updates", () => {
  it("emits created and updated events only to the scoped user", async () => {
    const ownerStream = openStream("sse_n_owner");
    const memberStream = openStream("sse_n_member");
    try {
      expect(await waitForEvent(ownerStream, "connected")).not.toBeNull();
      expect(await waitForEvent(memberStream, "connected")).not.toBeNull();

      await createUserNotification({
        id: "notif_live",
        userId: "n_owner",
        workspaceId,
        title: "Live",
      });
      expect(await waitForEvent(ownerStream, "notification.created")).not.toBeNull();
      await delay(120);
      expect(
        memberStream.events.some((event) => event.event === "notification.created"),
      ).toBe(false);

      const res = await request(app)
        .patch("/api/notifications/notif_owner_1/read")
        .set(auth(tokens.owner));
      expect(res.status).toBe(200);
      expect(await waitForEvent(ownerStream, "notification.updated")).not.toBeNull();
    } finally {
      ownerStream.close();
      memberStream.close();
    }
  });
});
