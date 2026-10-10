// Notification Center API.
//
// Every route is authenticated and workspace-scoped from the session: a caller
// can only create notifications for, and act on notifications belonging to,
// users in their own workspace. Notifications target a user id, and users live
// in the JSON store, so the target is validated by looking the user up in the
// caller's workspace rather than trusting the body.

import { readDb } from "../store.js";
import { auth } from "../middleware/auth.js";
import {
  createNotification,
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
} from "../services/notifications.js";

const DEFAULT_WORKSPACE = "default";

function workspaceOf(req) {
  return req.user?.workspaceId || req.user?.workspace_id || DEFAULT_WORKSPACE;
}

export default function registerNotificationRoutes(app) {
  // Direct creation, for system integrations and custom notifications.
  app.post("/api/notifications", auth, async (req, res) => {
    const { userId, type = "system", title, message = "", link = null, metadata = {} } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId is required" });
    if (!title) return res.status(400).json({ error: "title is required" });

    const workspaceId = workspaceOf(req);
    try {
      const db = await readDb();
      const target = (db.users || []).find(
        (user) => user.id === userId && (user.workspaceId || DEFAULT_WORKSPACE) === workspaceId,
      );
      if (!target) {
        // 404 rather than 403 so the response does not confirm a user id exists
        // in another tenant.
        return res.status(404).json({ error: "Recipient not found" });
      }
      const notification = await createNotification({
        userId: target.id,
        workspaceId,
        type,
        title,
        message,
        link,
        metadata,
        createdBy: req.user.id,
      });
      res.status(201).json(notification);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/notifications", auth, async (req, res) => {
    const workspaceId = workspaceOf(req);
    try {
      const unreadOnly = String(req.query.unreadOnly || "").toLowerCase() === "true";
      const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
      const result = await getUserNotifications({
        userId: req.user.id,
        workspaceId,
        unreadOnly,
        limit,
        offset,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  const markRead = async (req, res) => {
    const workspaceId = workspaceOf(req);
    try {
      const notification = await markNotificationAsRead({
        notificationId: req.params.id,
        userId: req.user.id,
        workspaceId,
      });
      if (!notification) return res.status(404).json({ error: "Notification not found" });
      res.json(notification);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
  app.patch("/api/notifications/:id/read", auth, markRead);
  app.put("/api/notifications/:id/read", auth, markRead);

  app.post("/api/notifications/read-all", auth, async (req, res) => {
    const workspaceId = workspaceOf(req);
    try {
      const result = await markAllNotificationsAsRead({ userId: req.user.id, workspaceId });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
