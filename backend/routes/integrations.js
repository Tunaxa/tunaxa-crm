// Integrations management API.
//
// GET  /api/integrations        - workspace integration config, secrets masked
// PUT  /api/integrations/slack  - configure the workspace Slack webhook URL
// PUT  /api/integrations/zapier - configure the workspace Zapier outbound URL
// POST /api/integrations/test   - probe connectivity to the configured webhooks
//
// URLs are stored per workspace inside settings.integrations, so each tenant
// reaches only the webhooks it configured. Reads return the configuration with
// the URL masked; the raw URL is a write-only secret.

import { mutateDb } from "../store.js";
import { auth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { id, now } from "../helpers.js";
import { cacheFlush } from "../services/cache.js";
import { broadcast } from "./sse.js";
import {
  getWorkspaceIntegrations,
  saveWorkspaceIntegration,
  postIntegrationTestPing,
} from "../services/integrations.js";

function tenantOf(req) {
  return req.user?.workspaceId || req.user?.workspace_id || "default";
}

// The URL is the secret here, so the read path never returns it in full.
function maskWebhookUrl(url) {
  if (!url) return "";
  try {
    const { origin } = new URL(url);
    return `${origin}/••••••${url.slice(-6)}`;
  } catch {
    return `${String(url).slice(0, 10)}••••••`;
  }
}

function sanitizeChannel(channel, url) {
  return { configured: Boolean(url), webhookUrlMasked: maskWebhookUrl(url) };
}

function validateWebhookUrl(value, label) {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url) return "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    const error = new Error(`${label} must be a valid URL`);
    error.status = 400;
    throw error;
  }
  if (parsed.protocol !== "https:") {
    const error = new Error(`${label} must be an https URL`);
    error.status = 400;
    throw error;
  }
  return parsed.toString();
}

function channelKeyFor(channel) {
  return channel === "slack" ? "slackWebhookUrl" : "zapierWebhookUrl";
}

async function readSanitized(workspaceId) {
  const { slackWebhookUrl, zapierWebhookUrl } =
    await getWorkspaceIntegrations(workspaceId);
  return {
    slack: sanitizeChannel("slack", slackWebhookUrl),
    zapier: sanitizeChannel("zapier", zapierWebhookUrl),
  };
}

async function writeChannel(req, res, channel) {
  const workspaceId = tenantOf(req);
  const url = validateWebhookUrl(req.body?.[channelKeyFor(channel)], channel);
  await saveWorkspaceIntegration({ workspaceId, channel, webhookUrl: url });
  await mutateAudit(req, `${channel} integration webhook updated`);
  cacheFlush();
  broadcast("integrations.updated", { by: req.user.name, channel });
  return res.json(await readSanitized(workspaceId));
}

async function mutateAudit(req, action) {
  await mutateDb((db) => {
    db.audit.unshift({
      id: id("audit"),
      action,
      actor: req.user.name,
      createdAt: now(),
    });
  });
}

export default function registerIntegrationRoutes(app) {
  app.get("/api/integrations", auth, async (req, res) => {
    res.json(await readSanitized(tenantOf(req)));
  });

  app.put("/api/integrations/slack", auth, requireAdmin, async (req, res, next) => {
    try {
      await writeChannel(req, res, "slack");
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/integrations/zapier", auth, requireAdmin, async (req, res, next) => {
    try {
      await writeChannel(req, res, "zapier");
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/integrations/test", auth, requireAdmin, async (req, res, next) => {
    try {
      const workspaceId = tenantOf(req);
      const result = await postIntegrationTestPing({ workspaceId });
      // A configured-but-failing webhook surfaces as the diagnostic; only when
      // nothing was even configured is it "no webhook".
      if (result.failed.length > 0) {
        return res.status(502).json({ error: result.failed[0], sent: result.sent });
      }
      if (result.sent.length === 0) {
        return res
          .status(400)
          .json({ error: "No webhook configured for this workspace" });
      }
      broadcast("integrations.test", { by: req.user.name, channels: result.sent });
      return res.json({ ok: true, sent: result.sent });
    } catch (error) {
      next(error);
    }
  });
}