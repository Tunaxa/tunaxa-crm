import crypto from "node:crypto";
import { query } from "../db/pg.js";
import { getWebhookQueue } from "../services/webhookQueue.js";
import { assertSafeWebhookUrl } from "../services/webhookSecurity.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";

const SUBSCRIPTION_COLUMNS =
  "id, url, events, is_active, created_at, updated_at";
const DANGEROUS_EVENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function normalizeWorkspace(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "default";
}

function workspaceIdFor(req) {
  return normalizeWorkspace(req.user?.workspaceId);
}

function normalizeEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const seen = new Set();
  const result = [];
  for (const entry of events) {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 100) {
      return null;
    }
    const event = entry.trim();
    if (DANGEROUS_EVENT_KEYS.has(event)) return null;
    if (seen.has(event)) continue;
    seen.add(event);
    result.push(event);
  }
  return result.length ? result : null;
}

function serializeSubscription(row, includeSecret = false) {
  const result = {
    id: row.id,
    url: row.url,
    events: row.events,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    hasSecret: Boolean(row.has_secret ?? row.secret),
  };
  if (includeSecret && typeof row.secret === "string") {
    result.secret = row.secret;
  }
  return result;
}

function invalidUrl(res) {
  return res.status(400).json({ error: "Invalid or unsafe webhook URL" });
}

export default function registerWebhookRoutes(app) {
  app.get("/api/v1/webhooks/events", auth, async (req, res) => {
    const { status, limit = 50 } = req.query;
    const params = [workspaceIdFor(req)];
    let sql = `SELECT * FROM webhook_events WHERE workspace_id = $1`;
    if (typeof status === "string" && status) {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }
    params.push(Math.min(Math.max(Number(limit) || 50, 1), 100));
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const result = await query(sql, params);
    res.json({ data: result.rows, total: result.rows.length });
  });

  app.post(
    "/api/v1/webhooks",
    auth,
    requireRole("admin", "member"),
    async (req, res) => {
      const { url } = req.body;
      const events = normalizeEvents(req.body.events);
      if (!url || !events) {
        return res
          .status(400)
          .json({ error: "url and events[] are required" });
      }

      try {
        await assertSafeWebhookUrl(url);
      } catch {
        return invalidUrl(res);
      }

      const secret = "whsec_" + crypto.randomBytes(32).toString("hex");
      const result = await query(
        `INSERT INTO webhook_subscriptions (workspace_id, url, secret, events)
         VALUES ($1, $2, $3, $4)
         RETURNING ${SUBSCRIPTION_COLUMNS}, (secret IS NOT NULL) AS has_secret`,
        [workspaceIdFor(req), url, secret, events],
      );

      const sub = serializeSubscription(result.rows[0]);
      sub.secret = secret;
      res.status(201).json(sub);
    },
  );

  app.get("/api/v1/webhooks", auth, async (req, res) => {
    const result = await query(
      `SELECT ${SUBSCRIPTION_COLUMNS}, (secret IS NOT NULL) AS has_secret
       FROM webhook_subscriptions
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [workspaceIdFor(req)],
    );
    res.json({
      data: result.rows.map((row) => serializeSubscription(row)),
      total: result.rows.length,
    });
  });

  app.get("/api/v1/webhooks/:id", auth, async (req, res) => {
    const result = await query(
      `SELECT ${SUBSCRIPTION_COLUMNS}, (secret IS NOT NULL) AS has_secret
       FROM webhook_subscriptions
       WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, workspaceIdFor(req)],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(serializeSubscription(result.rows[0]));
  });

  app.patch(
    "/api/v1/webhooks/:id",
    auth,
    requireRole("admin", "member"),
    async (req, res) => {
      const { url, is_active } = req.body;
      const events =
        req.body.events === undefined ? undefined : normalizeEvents(req.body.events);
      const sets = [];
      const params = [];
      let idx = 1;

      if (url !== undefined) {
        try {
          await assertSafeWebhookUrl(url);
        } catch {
          return invalidUrl(res);
        }
        sets.push(`url = $${idx++}`);
        params.push(url);
      }
      if (events !== undefined) {
        if (!events) {
          return res
            .status(400)
            .json({ error: "events must be a non-empty array" });
        }
        sets.push(`events = $${idx++}`);
        params.push(events);
      }
      if (is_active !== undefined) {
        if (typeof is_active !== "boolean") {
          return res.status(400).json({ error: "is_active must be a boolean" });
        }
        sets.push(`is_active = $${idx++}`);
        params.push(is_active);
      }

      if (sets.length === 0) {
        return res.status(400).json({ error: "Nothing to update" });
      }

      sets.push("updated_at = NOW()");
      params.push(req.params.id, workspaceIdFor(req));

      const result = await query(
        `UPDATE webhook_subscriptions
         SET ${sets.join(", ")}
         WHERE id = $${idx} AND workspace_id = $${idx + 1}
         RETURNING ${SUBSCRIPTION_COLUMNS}, (secret IS NOT NULL) AS has_secret`,
        params,
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Not found" });
      }
      res.json(serializeSubscription(result.rows[0]));
    },
  );

  app.delete(
    "/api/v1/webhooks/:id",
    auth,
    requireRole("admin", "member"),
    async (req, res) => {
      const result = await query(
        `DELETE FROM webhook_subscriptions
         WHERE id = $1 AND workspace_id = $2
         RETURNING id`,
        [req.params.id, workspaceIdFor(req)],
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Not found" });
      }
      res.json({ ok: true, deleted: req.params.id });
    },
  );
}

export async function dispatchWebhook(
  eventType,
  objectType,
  objectId,
  changedProperties = {},
  workspaceId = "default",
) {
  try {
    const tenant = normalizeWorkspace(workspaceId);
    const result = await query(
      `INSERT INTO webhook_events
        (event_type, object_id, object_type, changed_properties, workspace_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        eventType,
        objectId,
        objectType,
        JSON.stringify(changedProperties ?? {}),
        tenant,
      ],
    );
    const event_id = result.rows[0].id;

    const subs = await query(
      `SELECT id, url, secret, events
       FROM webhook_subscriptions
       WHERE is_active = true AND $1 = ANY(events) AND workspace_id = $2`,
      [eventType, tenant],
    );

    if (subs.rows.length === 0) {
      await query(
        `UPDATE webhook_events SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [event_id],
      );
      return;
    }

    const queue = getWebhookQueue();
    if (queue) {
      for (const sub of subs.rows) {
        try {
          await assertSafeWebhookUrl(sub.url);
        } catch (error) {
          console.error(`[webhook] Skipping unsafe destination: ${error.message}`);
          continue;
        }
        const payload = {
          event: eventType,
          delivery_id: event_id,
          object_type: objectType,
          object_id: objectId,
          changed: changedProperties,
          timestamp: new Date().toISOString(),
        };
        await queue.add(
          eventType,
          { event_id, url: sub.url, secret: sub.secret, payload },
          { jobId: `${event_id}-${sub.id}` },
        );
      }

      await query(
        `UPDATE webhook_events SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [event_id],
      );
      return;
    }

    await query(
      `UPDATE webhook_events SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [event_id],
    );
  } catch (error) {
    console.error(`[webhook] dispatch error:`, error.message);
  }
}
