// Integrations backend: deal.won webhook dispatch to Slack and Zapier.
//
// When a deal transitions into a won stage the workspace's configured Slack
// incoming webhook gets a formatted celebration message and the Zapier outbound
// webhook receives a structured `deal.won` event. All outbound traffic is
// fire-into-the-wind by design: dispatches run through Promise.allSettled and
// failures are logged, never thrown, so a third-party webhook that is down or
// slow can never fail the deal update that triggered it.
//
// Credentials are resolved per workspace (settings.integrations.slack/zapier
// webhook URL maps keyed by workspace id) with a deployment-level environment
// fallback, so events from ws_acme only ever reach ws_acme's webhooks.

import { getSettings } from "./config.js";
import { mutateDb } from "../store.js";

const DEFAULT_TIMEOUT_MS = 3000;

// Stage values are free text at the column level ('won' from the batch move,
// 'Closed Won' from the pipeline board), so the won check is a case-insensitive
// fixed set rather than a strict equality.
const WON_STAGES = new Set(["won", "closed won"]);

/** True when the stage means "won" (case-insensitive, 'won' / 'closed won'). */
export function isWonStage(stage) {
  return WON_STAGES.has(String(stage || "").trim().toLowerCase());
}

/**
 * Format an amount for the Slack copy, e.g. 50000 -> "$50,000".
 */
export function formatCurrency(amount, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(Number(amount) || 0);
  } catch {
    return `${currency} ${Number(amount) || 0}`;
  }
}

/**
 * The integration webhook URLs for one workspace.
 *
 * Per-workspace URLs win; the environment variables are a deployment-level
 * fallback used only when that workspace has not been configured, so a real
 * multi-tenant deployment keys each workspace independently.
 */
export async function getWorkspaceIntegrations(workspaceId = "default") {
  const settings = await getSettings();
  const slack = settings.integrations?.slack?.webhookUrls || {};
  const zapier = settings.integrations?.zapier?.webhookUrls || {};
  return {
    workspaceId,
    slackWebhookUrl: slack[workspaceId] || process.env.SLACK_WEBHOOK_URL || "",
    zapierWebhookUrl: zapier[workspaceId] || process.env.ZAPIER_WEBHOOK_URL || "",
  };
}

/**
 * Persist/clear a workspace webhook URL inside settings.integrations.
 *
 * A blank url clears the workspace's configuration. Returns the saved URL.
 */
export async function saveWorkspaceIntegration({
  workspaceId = "default",
  channel,
  webhookUrl = "",
}) {
  const url = String(webhookUrl || "").trim();
  await mutateDb((db) => {
    db.settings = db.settings || {};
    db.settings.integrations = db.settings.integrations || {};
    db.settings.integrations[channel] =
      db.settings.integrations[channel] || { webhookUrls: {} };
    const map = db.settings.integrations[channel].webhookUrls;
    if (url) {
      map[workspaceId] = url;
    } else {
      delete map[workspaceId];
    }
  });
  return url;
}

function createTimeoutSignal(timeoutMs) {
  if (typeof AbortController === "undefined") return { signal: null, cleanup: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

async function postJson(url, payload, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { signal, cleanup } = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`webhook responded ${response.status}`);
    }
  } finally {
    if (cleanup) cleanup();
  }
}

/**
 * The Slack incoming-webhook payload for a won deal:
 * a short message plus a richer mrkdwn block.
 */
export function buildSlackDealWonPayload({ deal, workspaceId, currency = "USD" }) {
  const title = deal.title || deal.name || "Untitled deal";
  const formatted = formatCurrency(deal.value, currency);
  const stage = deal.stage || "won";
  return {
    text: `🎉 Deal Won: *${title}* - ${formatted}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🎉 *Deal Won!*\n*Title:* ${title}\n*Value:* ${formatted} ${currency}\n*Stage:* ${stage}\n*Workspace:* ${workspaceId || ""}`,
        },
      },
    ],
  };
}

/** The structured Zapier outbound event for a won deal. */
export function buildZapierDealWonPayload({ deal, workspaceId, currency = "USD" }) {
  return {
    event: "deal.won",
    timestamp: new Date().toISOString(),
    workspaceId,
    deal: {
      id: deal.id || "",
      title: deal.title || deal.name || "",
      value: Number(deal.value) || 0,
      currency,
      stage: deal.stage || "won",
      contactId: deal.contactId || null,
    },
  };
}

/**
 * Push a celebration message to a Slack incoming webhook.
 * @throws when the webhook is unreachable or answers with a non-2xx status.
 */
export async function postDealWonToSlack({ webhookUrl, deal, workspaceId, currency = "USD", fetchImpl = globalThis.fetch }) {
  await postJson(
    webhookUrl,
    buildSlackDealWonPayload({ deal, workspaceId, currency }),
    fetchImpl,
  );
}

/**
 * Push the structured deal.won event to a Zapier outbound webhook.
 * @throws when the webhook is unreachable or answers with a non-2xx status.
 */
export async function postDealWonToZapier({ webhookUrl, deal, workspaceId, currency = "USD", fetchImpl = globalThis.fetch }) {
  await postJson(
    webhookUrl,
    buildZapierDealWonPayload({ deal, workspaceId, currency }),
    fetchImpl,
  );
}

/**
 * Fire deal.won notifications for one deal.
 *
 * Pre-conditions: the deal's current stage is a won stage AND the previous
 * stage was not already won (so updating an already-won deal is silent).
 *
 * Never throws: dispatch failures are collected with Promise.allSettled and
 * logged, so a bad webhook can neither fail the caller's write nor hold the
 * response past the per-webhook timeout.
 *
 * @returns {{ fired: boolean, reason?: string, results?: PromiseSettledResult[] }}
 */
export async function triggerDealWonIntegrations({ deal, previousStage, workspaceId = "default", fetchImpl = globalThis.fetch }) {
  try {
    if (!deal) return { fired: false, reason: "no-deal" };
    if (!isWonStage(deal.stage)) return { fired: false, reason: "not-won" };
    if (isWonStage(previousStage)) return { fired: false, reason: "already-won" };

    const [integrations, settings] = await Promise.all([
      getWorkspaceIntegrations(workspaceId),
      getSettings(),
    ]);
    if (!integrations.slackWebhookUrl && !integrations.zapierWebhookUrl) {
      return { fired: false, reason: "unconfigured" };
    }
    const currency = settings.currency || "USD";

    const jobs = [];
    if (integrations.slackWebhookUrl) {
      jobs.push(
        postDealWonToSlack({
          webhookUrl: integrations.slackWebhookUrl,
          deal,
          workspaceId,
          currency,
          fetchImpl,
        }).then(() => "slack"),
      );
    }
    if (integrations.zapierWebhookUrl) {
      jobs.push(
        postDealWonToZapier({
          webhookUrl: integrations.zapierWebhookUrl,
          deal,
          workspaceId,
          currency,
          fetchImpl,
        }).then(() => "zapier"),
      );
    }

    const results = await Promise.allSettled(jobs);
    for (const result of results) {
      if (result.status === "rejected") {
        console.error(
          `[integrations] deal.won webhook failed for deal ${deal.id} in ${workspaceId}:`,
          result.reason?.message || result.reason,
        );
      }
    }
    return { fired: true, results };
  } catch (error) {
    console.error(
      `[integrations] deal.won dispatch error for deal ${deal?.id} in ${workspaceId}:`,
      error.message || error,
    );
    return { fired: false, reason: "error" };
  }
}

/**
 * Send a connectivity probe to every webhook configured for the workspace.
 * Used by POST /api/integrations/test.
 */
export async function postIntegrationTestPing({ workspaceId = "default", fetchImpl = globalThis.fetch }) {
  const { slackWebhookUrl, zapierWebhookUrl } =
    await getWorkspaceIntegrations(workspaceId);
  const ping = {
    event: "test",
    timestamp: new Date().toISOString(),
    workspaceId,
    message: "Tunaxa integration test ping",
  };

  const jobs = [];
  if (slackWebhookUrl) {
    jobs.push(
      postJson(
        slackWebhookUrl,
        { text: `:white_check_mark: Integration test ping from Tunaxa (${workspaceId})` },
        fetchImpl,
      ).then(() => "slack"),
    );
  }
  if (zapierWebhookUrl) {
    jobs.push(postJson(zapierWebhookUrl, ping, fetchImpl).then(() => "zapier"));
  }

  const results = await Promise.allSettled(jobs);
  return {
    sent: results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value),
    failed: results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason?.message || String(result.reason || "error")),
  };
}