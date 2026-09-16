import crypto from "node:crypto";
import { query } from "../db/pg.js";
import { getWebhookQueue } from "../services/webhookQueue.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";

export default function registerWebhookRoutes(app) {
  // GET /api/v1/webhooks/events — List event log (MUST be before /:id)
  app.get("/api/v1/webhooks/events", auth, async (req, res) => {
    const { status, limit = 50 } = req.query;
    let sql = `SELECT * FROM webhook_events`;
    const params = [];
    if (status) {
      sql += ` WHERE status = $1`;
      params.push(status);
    }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(Math.min(Number(limit), 100));

    const result = await query(sql, params);
    res.json({ data: result.rows, total: result.rows.length });
  });

  // POST /api/v1/webhooks — Create subscription
  app.post(
    "/api/v1/webhooks",
    auth,
    requireRole("admin", "member"),
    async (req, res) => {
      const { url, events } = req.body;
      if (!url || !events || !Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ error: "url and events[] are required" });
      }

      try {
        new URL(url);
      } catch {
        return res.status(400).json({ error: "Invalid URL" });
      }

      const secret = "whsec_" + crypto.randomBytes(32).toString("hex");

      const result = await query(
        `INSERT INTO webhook_subscriptions (url, secret, events) VALUES ($1, $2, $3) RETURNING id, url, events, is_active, created_at`,
        [url, secret, events],
      );

      const sub = result.rows[0];
      sub.secret = secret;
      res.status(201).json(sub);
    },
  );

  // GET /api/v1/webhooks — List subscriptions
  app.get("/api/v1/webhooks", auth, async (_req, res) => {
    const result = await query(
      `SELECT id, url, events, is_active, created_at, updated_at FROM webhook_subscriptions ORDER BY created_at DESC`,
    );
    res.json({ data: result.rows, total: result.rows.length });
  });

  // GET /api/v1/webhooks/:id — Get subscription
  app.get("/api/v1/webhooks/:id", auth, async (req, res) => {
    const result = await query(
      `SELECT id, url, events, is_active, created_at, updated_at FROM webhook_subscriptions WHERE id = $1`,
      [req.params.id],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  });

  // PATCH /api/v1/webhooks/:id — Update subscription
  app.patch(
    "/api/v1/webhooks/:id",
    auth,
    requireRole("admin", "member"),
    async (req, res) => {
      const { url, events, is_active } = req.body;
      const sets = [];
      const params = [];
      let idx = 1;

      if (url !== undefined) {
        try {
          new URL(url);
        } catch {
          return res.status(400).json({ error: "Invalid URL" });
        }
        sets.push(`url = $${idx++}`);
        params.push(url);
      }
      if (events !== undefined) {
        if (!Array.isArray(events) || events.length === 0) {
          return res
            .status(400)
            .json({ error: "events must be a non-empty array" });
        }
        sets.push(`events = $${idx++}`);
        params.push(events);
      }
      if (is_active !== undefined) {
        sets.push(`is_active = $${idx++}`);
        params.push(is_active);
      }

      if (sets.length === 0)
        return res.status(400).json({ error: "Nothing to update" });

      sets.push(`updated_at = NOW()`);
      params.push(req.params.id);

      const result = await query(
        `UPDATE webhook_subscriptions SET ${sets.join(", ")} WHERE id = $${idx} RETURNING id, url, events, is_active, created_at, updated_at`,
        params,
      );
      if (result.rows.length === 0)
        return res.status(404).json({ error: "Not found" });
      res.json(result.rows[0]);
    },
  );

  // DELETE /api/v1/webhooks/:id
  app.delete(
    "/api/v1/webhooks/:id",
    auth,
    requireRole("admin", "member"),
    async (req, res) => {
      const result = await query(
        `DELETE FROM webhook_subscriptions WHERE id = $1 RETURNING id`,
        [req.params.id],
      );
      if (result.rows.length === 0)
        return res.status(404).json({ error: "Not found" });
      res.json({ ok: true, deleted: req.params.id });
    },
  );
}

export async function dispatchWebhook(
  eventType,
  objectType,
  objectId,
  changedProperties = {},
) {
  try {
    const result = await query(
      `INSERT INTO webhook_events (event_type, object_id, object_type, changed_properties)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [eventType, objectId, objectType, JSON.stringify(changedProperties)],
    );
    const event_id = result.rows[0].id;

    const subs = await query(
      `SELECT id, url, secret, events FROM webhook_subscriptions WHERE is_active = true AND $1 = ANY(events)`,
      [eventType],
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
          {
            jobId: `${event_id}-${sub.id}`,
          },
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
  } catch (err) {
    console.error(`[webhook] dispatch error:`, err.message);
  }
}
