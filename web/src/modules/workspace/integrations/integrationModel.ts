export type IntegrationChannel = { configured: boolean; webhookUrlMasked: string };
export type Integrations = { slack: IntegrationChannel; zapier: IntegrationChannel };
export const integrationNames = { slack: "Slack", zapier: "Zapier" } as const;
export type IntegrationKey = keyof Integrations;

export const canManageIntegrations = (role?: string) => ["admin", "Owner", "owner"].includes(role || "");

export function parseIntegrations(value: unknown): Integrations {
  const response = value as Integrations;
  const channel = (key: IntegrationKey): IntegrationChannel => {
    const row = response?.[key];
    if (!row || typeof row.configured !== "boolean" || typeof row.webhookUrlMasked !== "string"
      || (!row.configured && row.webhookUrlMasked !== "")
      || (row.configured && !/^https?:\/\/[^/?#@\s]+\/••••••[^\r\n]{0,6}$/u.test(row.webhookUrlMasked))) {
      throw new Error("Invalid integration configuration response");
    }
    // Retain only the contract's masked fields, never an unexpected raw URL.
    return { configured: row.configured, webhookUrlMasked: row.webhookUrlMasked };
  };
  return { slack: channel("slack"), zapier: channel("zapier") };
}

export function slackPayload(value: string) {
  const input = value.trim();
  if (!input) throw new Error("Paste a Slack incoming webhook URL");
  let parsed: URL;
  try { parsed = new URL(input); }
  catch { throw new Error("Enter a valid Slack incoming webhook URL"); }
  if (parsed.protocol !== "https:" || !["hooks.slack.com", "hooks.slack-gov.com"].includes(parsed.hostname)
    || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash
    || !/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u.test(parsed.pathname)) {
    throw new Error("Use the HTTPS incoming webhook URL copied from Slack’s app settings");
  }
  return { slackWebhookUrl: parsed.toString() };
}

export function assertSlackSaved(value: unknown, payload: ReturnType<typeof slackPayload>): Integrations {
  const config = parseIntegrations(value);
  const expectedMask = `${new URL(payload.slackWebhookUrl).origin}/••••••${payload.slackWebhookUrl.slice(-6)}`;
  if (!config.slack.configured || config.slack.webhookUrlMasked !== expectedMask) {
    throw new Error("Slack configuration could not be confirmed. Refresh before saving again.");
  }
  return config;
}

export function integrationError(failure: unknown, operation: "load" | "save") {
  const status = (failure as { status?: number })?.status;
  if (status === 401) return "Sign in again to access integrations.";
  if (status === 403) return operation === "save" ? "Only workspace administrators can configure integrations." : "You do not have access to integration configuration.";
  if (status === 404) return "Integrations are not available on this server yet. Retry after the integration service is enabled.";
  if (status === 400 && operation === "save") return "The server rejected the webhook URL. Check the URL copied from Slack.";
  return operation === "save" ? "Save could not be confirmed. Refresh and check the configuration before saving again." : "Could not load integration configuration. Retry to view its current status.";
}
