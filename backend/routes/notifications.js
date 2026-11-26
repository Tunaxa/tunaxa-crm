import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import {
  listUserNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  searchMentionableUsers,
} from "../services/notifications.js";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const writeAccess = requireRole("admin", "member");

function tenantOf(req) {
  return req.user?.workspaceId || req.user?.workspace_id || "default";
}

function integerQuery(value, fallback, min, max) {
  if (value === undefined) return { ok: true, value: fallback };
  if (!/^\d+$/.test(String(value))) return { ok: false };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
}

function booleanQuery(value, fallback) {
  if (value === undefined) return { ok: true, value: fallback };
  if (value === "true") return { ok: true, value: true };
  if (value === "false") return { ok: true, value: false };
  return { ok: false };
}

function validId(value) {
  return (
    typeof value === "string" &&
    ID_PATTERN.test(value) &&
    !DANGEROUS_KEYS.has(value)
  );
}

export default function registerNotificationRoutes(app) {
  app.get("/api/notifications", auth, async (req, res) => {
    const limit = integerQuery(req.query.limit, 50, 1, 100);
    const offset = integerQuery(req.query.offset, 0, 0, 100000);
    const unreadOnly = booleanQuery(req.query.unreadOnly, false);
    if (!limit.ok || !offset.ok || !unreadOnly.ok) {
      return res.status(400).json({ error: "Invalid notification query" });
    }
    try {
      const result = await listUserNotifications({
        userId: req.user.id,
        workspaceId: tenantOf(req),
        limit: limit.value,
        offset: offset.value,
        unreadOnly: unreadOnly.value,
      });
      return res.json(result);
    } catch (error) {
      console.error("[notifications] list failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/notifications/mentionable", auth, async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q : "";
    if (
      query.length > 80 ||
      Array.from(query).some((char) => {
        const code = char.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      return res.status(400).json({ error: "Invalid mention query" });
    }
    try {
      const users = await searchMentionableUsers({
        query,
        workspaceId: tenantOf(req),
        userId: req.user.id,
      });
      return res.json(users);
    } catch (error) {
      console.error("[notifications] mention lookup failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch(
    "/api/notifications/:id/read",
    auth,
    writeAccess,
    async (req, res) => {
      if (!validId(req.params.id)) {
        return res.status(400).json({ error: "Invalid notification id" });
      }
      try {
        const result = await markNotificationRead({
          id: req.params.id,
          userId: req.user.id,
          workspaceId: tenantOf(req),
        });
        if (result.status === "invalid") {
          return res.status(400).json({ error: "Invalid notification id" });
        }
        if (result.status === "missing") {
          return res.status(404).json({ error: "Notification not found" });
        }
        return res.json(result.notification);
      } catch (error) {
        console.error("[notifications] read update failed:", error);
        return res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  app.post("/api/notifications/read-all", auth, writeAccess, async (req, res) => {
    try {
      const result = await markAllNotificationsRead({
        userId: req.user.id,
        workspaceId: tenantOf(req),
      });
      return res.json({ updated: result.updated });
    } catch (error) {
      console.error("[notifications] read-all update failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });
}
