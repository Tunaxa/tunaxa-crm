// Notification Center & @mention trigger.
//
// Two layers:
//   1. Pure service tests over the JSON store (no database): mention token
//      parsing, workspace-scoped recipient resolution, and notification
//      create/list/read lifecycle.
//   2. End-to-end HTTP tests (skipped when Postgres is unreachable, because a
//      ticket comment is written to the Postgres `tickets` table): the
//      notification REST API and the "@mentioned user gets a notification"
//      criterion, including self-mention suppression, duplicate-handle
//      deduplication, and cross-tenant isolation.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { resetTestDb, cleanupTestDb } from "./setup.js";
import { mutateDb } from "../store.js";
import { query } from "../db/pg.js";
import {
  extractMentionHandles,
  resolveMentionedUsers,
} from "../services/mentions.js";
import {
  createNotification,
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
} from "../services/notifications.js";

const ACME = "ws_acme";
const MATRIX = "ws_matrix";

const SARAH = {
  id: "usr_sarah",
  name: "Sarah Connor",
  username: "sarah",
  email: "sarah.connor@cyberdyne.com",
  role: "member",
  workspaceId: ACME,
};
const KYLE = {
  id: "usr_kyle",
  name: "Kyle Reese",
  username: "kyle",
  email: "kyle.reese@cyberdyne.com",
  role: "member",
  workspaceId: ACME,
};
const JOHN = {
  id: "usr_john",
  name: "John Doe",
  username: "john",
  email: "john@example.com",
  role: "member",
  workspaceId: ACME,
};
const SMITH = {
  id: "usr_smith",
  name: "Agent Smith",
  username: "agent_smith",
  email: "agent.smith@matrix.io",
  role: "member",
  workspaceId: MATRIX,
};

let pgReady = false;
try {
  await query("SELECT 1 FROM tickets LIMIT 1");
  pgReady = true;
} catch (error) {
  console.warn(
    `[notifications-mentions] Postgres is unreachable (${error.code || error.message}) - skipping database and HTTP assertions. Set PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE and re-run.`,
  );
}

async function seedUsers(users) {
  await mutateDb((db) => {
    for (const user of users) {
      db.users.push({ ...user, password: "x", createdAt: new Date().toISOString() });
    }
  });
}

async function seedSession(userId) {
  const token = `token_${userId}`;
  await mutateDb((db) => {
    db.sessions.push({
      token,
      userId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  });
  return token;
}

// ===========================================================================
describe("Mention parsing & notification service", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("extracts unique handles and strips trailing sentence punctuation", () => {
    expect(extractMentionHandles("Hey @sarah and @sarah, check this with @john.")).toEqual([
      "sarah",
      "john",
    ]);
    expect(extractMentionHandles("no handles here")).toEqual([]);
    expect(extractMentionHandles("")).toEqual([]);
    expect(extractMentionHandles(null)).toEqual([]);
  });

  it("captures full email handles in one token", () => {
    expect(extractMentionHandles("ping @sarah.connor@cyberdyne.com now")).toEqual([
      "sarah.connor@cyberdyne.com",
    ]);
    expect(extractMentionHandles("cc @sarah.connor please")).toEqual(["sarah.connor"]);
  });

  it("resolves mentioned users within the workspace and deduplicates", async () => {
    await seedUsers([SARAH, KYLE, JOHN, SMITH]);

    const resolved = await resolveMentionedUsers("@sarah and @sarah again", ACME);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe(SARAH.id);

    const byEmail = await resolveMentionedUsers("@sarah.connor@cyberdyne.com", ACME);
    expect(byEmail.map((u) => u.id)).toEqual([SARAH.id]);

    const byName = await resolveMentionedUsers("@sarah.connor", ACME);
    expect(byName.map((u) => u.id)).toEqual([SARAH.id]);

    // Agent Smith lives in ws_matrix, so a ws_acme comment cannot reach him.
    expect(await resolveMentionedUsers("@agent_smith", ACME)).toEqual([]);
  });

  it("creates, lists (with unread count) and scopes notifications", async () => {
    await createNotification({ userId: SARAH.id, workspaceId: ACME, title: "Hello", message: "world" });

    const acme = await getUserNotifications({ userId: SARAH.id, workspaceId: ACME });
    expect(acme.total).toBe(1);
    expect(acme.unreadCount).toBe(1);
    expect(acme.notifications[0].read).toBe(false);

    const matrix = await getUserNotifications({ userId: SARAH.id, workspaceId: MATRIX });
    expect(matrix.total).toBe(0);
  });

  it("marks a single notification read and refuses cross-user access", async () => {
    const notification = await createNotification({ userId: SARAH.id, workspaceId: ACME, title: "One" });

    expect(await markNotificationAsRead({ notificationId: notification.id, userId: KYLE.id, workspaceId: ACME })).toBeNull();

    const marked = await markNotificationAsRead({ notificationId: notification.id, userId: SARAH.id, workspaceId: ACME });
    expect(marked.read).toBe(true);

    const after = await getUserNotifications({ userId: SARAH.id, workspaceId: ACME });
    expect(after.unreadCount).toBe(0);
  });

  it("marks all notifications read for the recipient", async () => {
    await createNotification({ userId: SARAH.id, workspaceId: ACME, title: "One" });
    await createNotification({ userId: SARAH.id, workspaceId: ACME, title: "Two" });
    await createNotification({ userId: KYLE.id, workspaceId: ACME, title: "Not Sarah's" });

    const result = await markAllNotificationsAsRead({ userId: SARAH.id, workspaceId: ACME });
    expect(result.updated).toBe(2);

    const sarah = await getUserNotifications({ userId: SARAH.id, workspaceId: ACME });
    expect(sarah.unreadCount).toBe(0);
    const kyle = await getUserNotifications({ userId: KYLE.id, workspaceId: ACME });
    expect(kyle.unreadCount).toBe(1);
  });
});

// ===========================================================================
describe.skipIf(!pgReady)("Notification API & @mention triggers", () => {
  let app;
  let sarahToken;
  let kyleToken;
  let smithToken;

  beforeAll(async () => {
    await resetTestDb();
    const mod = await import("../server.js");
    app = mod.app;
  });

  beforeEach(async () => {
    await resetTestDb();
    await seedUsers([SARAH, KYLE, JOHN, SMITH]);
    sarahToken = await seedSession(SARAH.id);
    kyleToken = await seedSession(KYLE.id);
    smithToken = await seedSession(SMITH.id);
  });

  afterAll(() => cleanupTestDb());

  const as = (token) => (req) => req.set("Authorization", `Bearer ${token}`);

  async function createTicket(token, subject = "Payload schema review") {
    const res = await as(token)(request(app).post("/api/tickets")).send({ subject, contact: "Cyberdyne" });
    expect(res.status).toBe(201);
    return res.body;
  }

  it("creates, lists and acknowledges notifications over HTTP", async () => {
    const created = await as(kyleToken)(request(app).post("/api/notifications")).send({
      userId: SARAH.id,
      type: "system",
      title: "Report Export Ready",
      message: "Your Q3 sales report is ready to download.",
      link: "/reports/q3",
    });
    expect(created.status).toBe(201);
    expect(created.body.read).toBe(false);

    const list = await as(sarahToken)(request(app).get("/api/notifications"));
    expect(list.status).toBe(200);
    expect(list.body.notifications).toHaveLength(1);
    expect(list.body.unreadCount).toBe(1);
    expect(list.body.total).toBe(1);
    expect(list.body.notifications[0].title).toBe("Report Export Ready");

    const read = await as(sarahToken)(request(app).patch(`/api/notifications/${created.body.id}/read`));
    expect(read.status).toBe(200);
    expect(read.body.read).toBe(true);

    const after = await as(sarahToken)(request(app).get("/api/notifications"));
    expect(after.body.unreadCount).toBe(0);

    // Ownership: Kyle cannot read Sarah's notification.
    const foreign = await as(kyleToken)(request(app).patch(`/api/notifications/${created.body.id}/read`));
    expect(foreign.status).toBe(404);
  });

  it("marks all notifications read for the caller", async () => {
    await as(kyleToken)(request(app).post("/api/notifications")).send({ userId: SARAH.id, title: "One" });
    await as(kyleToken)(request(app).post("/api/notifications")).send({ userId: SARAH.id, title: "Two" });

    const all = await as(sarahToken)(request(app).post("/api/notifications/read-all"));
    expect(all.status).toBe(200);
    expect(all.body.updated).toBe(2);

    const list = await as(sarahToken)(request(app).get("/api/notifications"));
    expect(list.body.unreadCount).toBe(0);
  });

  it("notifies a user mentioned in a ticket comment", async () => {
    const ticket = await createTicket(kyleToken);

    const comment = await as(kyleToken)(
      request(app).post(`/api/tickets/${ticket.id}/comment`),
    ).send({ body: "Please review the payload schema @sarah before we deploy." });
    expect(comment.status).toBe(201);

    const sarah = await as(sarahToken)(request(app).get("/api/notifications"));
    expect(sarah.body.total).toBe(1);
    const mention = sarah.body.notifications[0];
    expect(mention.type).toBe("mention");
    expect(mention.title).toBe("Kyle Reese mentioned you");
    expect(mention.message).toContain("Please review the payload schema");
    expect(mention.link).toBe(`/ticket/${ticket.id}`);

    const kyle = await as(kyleToken)(request(app).get("/api/notifications"));
    expect(kyle.body.total).toBe(0);
  });

  it("suppresses self-mentions", async () => {
    const ticket = await createTicket(kyleToken);
    const comment = await as(kyleToken)(
      request(app).post(`/api/tickets/${ticket.id}/comments`),
    ).send({ body: "I will take care of this @kyle." });
    expect(comment.status).toBe(201);

    const kyle = await as(kyleToken)(request(app).get("/api/notifications"));
    expect(kyle.body.total).toBe(0);
  });

  it("deduplicates repeated handles but still notifies each distinct target", async () => {
    const ticket = await createTicket(kyleToken);
    const comment = await as(kyleToken)(
      request(app).post(`/api/tickets/${ticket.id}/comment`),
    ).send({ body: "Hey @sarah and @sarah, check this with @john." });
    expect(comment.status).toBe(201);

    const sarah = await as(sarahToken)(request(app).get("/api/notifications"));
    expect(sarah.body.total).toBe(1);

    const johnToken = await seedSession(JOHN.id);
    const john = await as(johnToken)(request(app).get("/api/notifications"));
    expect(john.body.total).toBe(1);
  });

  it("does not notify a cross-tenant user mentioned in a comment", async () => {
    const ticket = await createTicket(kyleToken);
    const comment = await as(kyleToken)(
      request(app).post(`/api/tickets/${ticket.id}/comment`),
    ).send({ body: "Be careful of @agent_smith." });
    expect(comment.status).toBe(201);

    const smith = await as(smithToken)(request(app).get("/api/notifications"));
    expect(smith.body.total).toBe(0);
  });

  it("rejects direct notification creation for a user in another workspace", async () => {
    const res = await as(kyleToken)(request(app).post("/api/notifications")).send({
      userId: SMITH.id,
      title: "Cross-tenant attempt",
    });
    expect(res.status).toBe(404);
  });
});
