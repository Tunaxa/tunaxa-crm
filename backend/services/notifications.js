import { randomUUID } from "node:crypto";
import { mutateDb, readDb } from "../store.js";
import { broadcastToUser } from "../routes/sse.js";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FIELD_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const LINK_PATTERN = /^\/(?:contacts|leads|companies|deals|invoices|quotes|contracts)\/[A-Za-z0-9_-]+$/;
const MAX_TITLE = 200;
const MAX_MESSAGE = 2000;
const MAX_QUERY = 80;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sanitizeFieldKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.length > 100) return null;
  if (DANGEROUS_KEYS.has(key)) return null;
  if (key.includes(".") || key.includes("[") || key.includes("]")) return null;
  if (!FIELD_KEY_PATTERN.test(key)) return null;
  return key;
}

function safeFields(value) {
  const result = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const key of Object.keys(value)) {
    const safe = sanitizeFieldKey(key);
    if (!safe || !hasOwn(value, key)) continue;
    result[safe] = value[key];
  }
  return result;
}

function isValidId(value) {
  return typeof value === "string" && ID_PATTERN.test(value) && !DANGEROUS_KEYS.has(value);
}

function isValidScope(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

function safeText(value, fallback, max) {
  return typeof value === "string" && value.length <= max ? value : fallback;
}

function safeDate(value) {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  return new Date(0).toISOString();
}

export function isSafeNotificationLink(value) {
  if (typeof value !== "string" || !value) return false;
  if (/[\\\s%?#]/u.test(value)) return false;
  return LINK_PATTERN.test(value);
}

function normalizeNotification(value) {
  const row = safeFields(value);
  if (!isValidId(row.id)) return null;
  const link = isSafeNotificationLink(row.link) ? row.link : null;
  return {
    id: row.id,
    userId: safeText(row.userId, "", 200),
    workspaceId: safeText(row.workspaceId, "", 200),
    title: safeText(row.title, "Notification", MAX_TITLE),
    message: safeText(row.message, "", MAX_MESSAGE),
    type: safeText(row.type, "system", 40),
    link,
    read: row.read === true,
    createdAt: safeDate(row.createdAt),
  };
}

function publicNotification(notification) {
  return {
    id: notification.id,
    title: notification.title,
    message: notification.message,
    type: notification.type,
    link: notification.link,
    read: notification.read,
    createdAt: notification.createdAt,
  };
}

function storedRows(db) {
  if (!Array.isArray(db.userNotifications)) db.userNotifications = [];
  return db.userNotifications.map(normalizeNotification).filter(Boolean);
}

function inScope(notification, userId, workspaceId) {
  return notification.userId === userId && notification.workspaceId === workspaceId;
}

function unreadCountFor(db, userId, workspaceId) {
  return storedRows(db).filter(
    (notification) => inScope(notification, userId, workspaceId) && !notification.read,
  ).length;
}

export async function listUserNotifications({
  userId,
  workspaceId,
  limit = 50,
  offset = 0,
  unreadOnly = false,
}) {
  if (!isValidScope(userId) || !isValidScope(workspaceId)) {
    return { notifications: [], unreadCount: 0, total: 0 };
  }
  const db = await readDb();
  const scoped = storedRows(db).filter((notification) =>
    inScope(notification, userId, workspaceId),
  );
  const unreadCount = scoped.filter((notification) => !notification.read).length;
  const filtered = unreadOnly
    ? scoped.filter((notification) => !notification.read)
    : scoped;
  filtered.sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
  return {
    notifications: filtered.slice(offset, offset + limit).map(publicNotification),
    unreadCount,
    total: filtered.length,
  };
}

export async function markNotificationRead({ id, userId, workspaceId }) {
  if (!isValidId(id)) return { status: "invalid" };
  const result = await mutateDb((db) => {
    const rows = storedRows(db);
    const index = rows.findIndex(
      (notification) =>
        notification.id === id && inScope(notification, userId, workspaceId),
    );
    if (index < 0) return { status: "missing" };
    rows[index] = { ...rows[index], read: true, readAt: new Date().toISOString() };
    db.userNotifications = rows;
    return {
      status: "ok",
      notification: publicNotification(rows[index]),
      unreadCount: unreadCountFor(db, userId, workspaceId),
    };
  });
  if (result.status === "ok") {
    broadcastToUser(userId, "notification.updated", {
      id: result.notification.id,
      unreadCount: result.unreadCount,
    });
  }
  return result;
}

export async function markAllNotificationsRead({ userId, workspaceId }) {
  const result = await mutateDb((db) => {
    const rows = storedRows(db);
    let updated = 0;
    db.userNotifications = rows.map((notification) => {
      if (!inScope(notification, userId, workspaceId) || notification.read) {
        return notification;
      }
      updated += 1;
      return { ...notification, read: true, readAt: new Date().toISOString() };
    });
    return { updated, unreadCount: unreadCountFor(db, userId, workspaceId) };
  });
  broadcastToUser(userId, "notification.updated", {
    updated: result.updated,
    unreadCount: result.unreadCount,
  });
  return result;
}

export async function createUserNotification({
  id,
  userId,
  workspaceId,
  type = "system",
  title,
  message = "",
  link = null,
  createdAt,
}) {
  if (!isValidScope(userId) || !isValidScope(workspaceId)) {
    throw new Error("Notification requires a user and workspace");
  }
  const notification = {
    id: isValidId(id) ? id : randomUUID(),
    userId,
    workspaceId,
    type: safeText(type, "system", 40),
    title: safeText(title, "Notification", MAX_TITLE),
    message: safeText(message, "", MAX_MESSAGE),
    link: isSafeNotificationLink(link) ? link : null,
    read: false,
    createdAt: safeDate(createdAt || new Date().toISOString()),
  };
  const unreadCount = await mutateDb((db) => {
    const rows = storedRows(db);
    if (rows.some((row) => row.id === notification.id)) {
      throw new Error("Notification id already exists");
    }
    db.userNotifications = [notification, ...rows];
    return unreadCountFor(db, userId, workspaceId);
  });
  broadcastToUser(userId, "notification.created", {
    id: notification.id,
    unreadCount,
  });
  return publicNotification(notification);
}

export async function searchMentionableUsers({ query, workspaceId, userId }) {
  if (!isValidScope(workspaceId)) return [];
  const needle = safeText(query, "", MAX_QUERY)
    .trim()
    .toLowerCase();
  if (!needle) return [];
  const db = await readDb();
  if (!Array.isArray(db.users)) return [];
  return db.users
    .map(safeFields)
    .filter((user) => {
      if (!isValidId(user.id) || user.id === userId) return false;
      const tenant = user.workspaceId || user.workspace_id || "default";
      if (tenant !== workspaceId) return false;
      const name = safeText(user.name, "", MAX_TITLE).toLowerCase();
      const email = safeText(user.email, "", MAX_TITLE).toLowerCase();
      return name.includes(needle) || email.includes(needle);
    })
    .slice(0, 10)
    .map((user) => ({
      id: user.id,
      name: safeText(user.name, "", MAX_TITLE),
      email: safeText(user.email, "", MAX_TITLE),
    }));
}
