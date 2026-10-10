// In-app notification center.
//
// Notifications are per-recipient records scoped to a workspace. They are kept
// in the JSON store alongside users/sessions rather than Postgres: there is no
// `users` table (users live in db.json) and the notification references a user
// id, so putting notifications in PG would only recreate the split that the
// lifecycle/leadscoring gap already suffers from. See SECURITY.md's catalog of
// legacy JSON collections.

import { readDb, mutateDb } from "../store.js";
import { id, now } from "../helpers.js";
import { broadcast } from "../routes/sse.js";

const DEFAULT_WORKSPACE = "default";

// The empty seed (`backend/__tests__/setup.js`) predates notifications, so a
// freshly reset store has no `notifications` key. Every accessor lazily creates
// the array instead of relying on a migration, which keeps old db.json files
// working without a rewrite.
function notificationsOf(db) {
  if (!Array.isArray(db.notifications)) db.notifications = [];
  return db.notifications;
}

function inWorkspace(record, workspaceId) {
  if (!workspaceId) return true;
  return (record.workspaceId || DEFAULT_WORKSPACE) === workspaceId;
}

/**
 * Persist a notification for `userId` and push it to any live SSE stream the
 * recipient has open. The SSE push is best-effort: a notification that is
 * stored but not streamed is still delivered on the next GET.
 */
export async function createNotification({
  userId,
  workspaceId,
  type = "system",
  title,
  message = "",
  link = null,
  metadata = {},
  createdBy = null,
}) {
  if (!userId) throw new Error("createNotification requires a userId");
  if (!title) throw new Error("createNotification requires a title");

  const notification = await mutateDb((db) => {
    const record = {
      id: id("notif"),
      userId,
      workspaceId: workspaceId || DEFAULT_WORKSPACE,
      type,
      title,
      message,
      link,
      read: false,
      readAt: null,
      metadata,
      createdBy,
      createdAt: now(),
    };
    notificationsOf(db).unshift(record);
    return record;
  });

  try {
    broadcast("notification.created", notification, userId);
  } catch (error) {
    console.error("[notifications] SSE broadcast failed:", error?.message || error);
  }
  return notification;
}

/**
 * Workspace-scoped notifications for a single recipient, newest first, with the
 * unread count computed across the whole set (not just the returned page) so a
 * badge stays correct while paging.
 */
export async function getUserNotifications({
  userId,
  workspaceId,
  unreadOnly = false,
  limit = 50,
  offset = 0,
}) {
  const db = await readDb();
  const all = (db.notifications || []).filter(
    (record) => record.userId === userId && inWorkspace(record, workspaceId),
  );
  const unreadCount = all.filter((record) => !record.read).length;
  const filtered = unreadOnly ? all.filter((record) => !record.read) : all;
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 50;
  const safeOffset = Number.isFinite(Number(offset)) && Number(offset) > 0 ? Number(offset) : 0;
  return {
    notifications: filtered.slice(safeOffset, safeOffset + safeLimit),
    unreadCount,
    total: filtered.length,
  };
}

/** Mark one notification read. Returns null when it is not the caller's. */
export async function markNotificationAsRead({ notificationId, userId, workspaceId }) {
  return mutateDb((db) => {
    const record = notificationsOf(db).find(
      (entry) =>
        entry.id === notificationId &&
        entry.userId === userId &&
        inWorkspace(entry, workspaceId),
    );
    if (!record) return null;
    if (!record.read) {
      record.read = true;
      record.readAt = now();
    }
    return record;
  });
}

/** Mark every unread notification for the recipient in the workspace read. */
export async function markAllNotificationsAsRead({ userId, workspaceId }) {
  return mutateDb((db) => {
    let updated = 0;
    for (const record of notificationsOf(db)) {
      if (record.userId !== userId || !inWorkspace(record, workspaceId) || record.read) continue;
      record.read = true;
      record.readAt = now();
      updated += 1;
    }
    return { updated };
  });
}
