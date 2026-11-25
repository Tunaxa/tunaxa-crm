import { hasOwn, sanitizeFieldKey } from "../../../components/records/urlSecurity";

export type IntegrationChannel = { configured: boolean; webhookUrlMasked: string };
export type Integrations = { slack: IntegrationChannel; zapier: IntegrationChannel };
export type IntegrationKey = keyof Integrations;

const CHANNELS: readonly IntegrationKey[] = ["slack", "zapier"];
const ALLOWED_CHANNELS: Readonly<Record<string, boolean>> = Object.freeze({
  slack: true,
  zapier: true,
});
const MASK_MESSAGE = "Invalid integration configuration response";
const SLACK_MASK = /^https:\/\/hooks\.slack\.com\/••••••[A-Za-z0-9_-]{0,6}$/u;
const GENERIC_MASK = /^https:\/\/[A-Za-z0-9.-]+\/••••••[A-Za-z0-9_-]{0,6}$/u;
const SLACK_PATH =
  /^\/services\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{6,255}$/u;
export const integrationNames: Readonly<Record<IntegrationKey, string>> = Object.freeze(
  Object.assign(Object.create(null), { slack: "Slack", zapier: "Zapier" }),
);

export const canManageIntegrations = (role?: string) =>
  ["admin", "Owner", "owner"].includes(role || "");

function assertSafeObjectKeys(value: object) {
  for (const key of Object.keys(value)) {
    if (!sanitizeFieldKey(key)) throw new Error(MASK_MESSAGE);
  }
}

function parseChannel(key: IntegrationKey, raw: unknown): IntegrationChannel {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(MASK_MESSAGE);
  }
  const row = raw as Record<string, unknown>;
  assertSafeObjectKeys(row);
  if (
    !hasOwn(row, "configured") ||
    typeof row.configured !== "boolean" ||
    !hasOwn(row, "webhookUrlMasked") ||
    typeof row.webhookUrlMasked !== "string"
  ) {
    throw new Error(MASK_MESSAGE);
  }
  const mask = row.webhookUrlMasked;
  if (!row.configured && mask !== "") throw new Error(MASK_MESSAGE);
  const pattern = key === "slack" ? SLACK_MASK : GENERIC_MASK;
  if (row.configured && !pattern.test(mask)) throw new Error(MASK_MESSAGE);
  return { configured: row.configured, webhookUrlMasked: mask };
}

export function parseIntegrations(value: unknown): Integrations {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(MASK_MESSAGE);
  }
  const response = value as Record<string, unknown>;
  const safe = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(response)) {
    const safeKey = sanitizeFieldKey(key);
    if (!safeKey) throw new Error(MASK_MESSAGE);
    if (!hasOwn(ALLOWED_CHANNELS, safeKey)) continue;
    safe[safeKey] = response[key];
  }
  for (const key of CHANNELS) {
    if (!hasOwn(safe, key)) throw new Error(MASK_MESSAGE);
  }
  return {
    slack: parseChannel("slack", safe.slack),
    zapier: parseChannel("zapier", safe.zapier),
  };
}

export function slackPayload(value: string) {
  const input = value.trim();
  if (!input) throw new Error("Paste a Slack incoming webhook URL");
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Enter a valid Slack incoming webhook URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== "https://hooks.slack.com" ||
    parsed.hostname !== "hooks.slack.com" ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !SLACK_PATH.test(parsed.pathname)
  ) {
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

export function assertSlackDisconnected(value: unknown): Integrations {
  const config = parseIntegrations(value);
  if (config.slack.configured || config.slack.webhookUrlMasked !== "") {
    throw new Error("Slack disconnect could not be confirmed. Refresh before trying again.");
  }
  return config;
}

export type SlackTestResult = {
  success: boolean;
  configured: boolean;
  provider: string;
  message?: string;
};

export function parseSlackTest(value: unknown): SlackTestResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Slack test response was invalid");
  }
  const result = value as Record<string, unknown>;
  assertSafeObjectKeys(result);
  if (
    typeof result.success !== "boolean" ||
    typeof result.configured !== "boolean" ||
    typeof result.provider !== "string" ||
    (result.message !== undefined && typeof result.message !== "string")
  ) {
    throw new Error("Slack test response was invalid");
  }
  return {
    success: result.success,
    configured: result.configured,
    provider: result.provider,
    ...(result.message === undefined ? {} : { message: result.message }),
  };
}

export function integrationError(
  failure: unknown,
  operation: "load" | "save" | "disconnect" | "test",
) {
  const status = (failure as { status?: number })?.status;
  if (status === 401) return "Sign in again to access integrations.";
  if (status === 403) return "Only workspace administrators can manage integrations.";
  if (status === 404) return "Integrations are unavailable right now. Retry shortly.";
  if (status === 400 && operation === "save") {
    return "The server rejected the webhook URL. Check the URL copied from Slack.";
  }
  if (status === 502 || operation === "test") {
    return "Slack webhook did not respond successfully. Check the saved webhook.";
  }
  if (operation === "disconnect") return "Slack could not be disconnected. Retry.";
  if (operation === "save") return "Save could not be confirmed. Refresh and try again.";
  return "Could not load integration configuration. Retry to view its current status.";
}
