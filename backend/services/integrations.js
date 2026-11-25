import net from "node:net";
import { readDb, mutateDb } from "../store.js";
import { id, now } from "../helpers.js";

export const INTEGRATION_EVENT = "integration.updated";

const SLACK_HOST = "hooks.slack.com";
const SLACK_PATH =
  /^\/services\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{6,255}$/u;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_KEY_DEPTH = 8;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function internalError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function hasOwn(value, key) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeWorkspaceId(value) {
  if (typeof value !== "string") return "";
  const key = value.trim();
  return UNSAFE_KEYS.has(key) || !key || key.length > 200 ? "" : key;
}

export function workspaceIdOf(user) {
  const workspaceId = sanitizeWorkspaceId(user?.workspaceId);
  if (workspaceId) return workspaceId;
  const userId = sanitizeWorkspaceId(user?.id);
  return userId ? `user:${userId}` : "default";
}

export function workspaceKey(workspaceId) {
  return `ws_${sanitizeWorkspaceId(workspaceId) || "default"}`;
}

export function assertSafeKeys(value, depth = 0) {
  if (!isObject(value) && !Array.isArray(value)) return;
  if (depth > MAX_KEY_DEPTH) throw badRequest("Request body is too deeply nested");
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    if (symbol) throw badRequest("Unsafe configuration key");
  }
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) throw badRequest("Unsafe configuration key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.value) continue;
    if (typeof descriptor.value === "object") {
      assertSafeKeys(descriptor.value, depth + 1);
    }
  }
}

export function validateSlackWebhookUrl(value) {
  if (typeof value !== "string" || value !== value.trim()) {
    throw badRequest("Enter a valid Slack incoming webhook URL");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest("Enter a valid Slack incoming webhook URL");
  }
  const invalid =
    parsed.protocol !== "https:" ||
    parsed.host !== SLACK_HOST ||
    parsed.hostname !== SLACK_HOST ||
    net.isIP(parsed.hostname) !== 0 ||
    Boolean(parsed.username) ||
    Boolean(parsed.password) ||
    Boolean(parsed.port) ||
    Boolean(parsed.search) ||
    Boolean(parsed.hash) ||
    !SLACK_PATH.test(parsed.pathname);
  if (invalid) {
    throw badRequest("Use the HTTPS incoming webhook URL copied from Slack’s app settings");
  }
  return parsed.toString();
}

export function maskWebhookUrl(value) {
  if (typeof value !== "string" || !value) return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  return `${parsed.origin}/••••••${value.slice(-6)}`;
}

function ownString(value, key) {
  return hasOwn(value, key) && typeof value[key] === "string" ? value[key] : "";
}

function readStored(db, workspaceId) {
  const integrations = isObject(db.integrations) ? db.integrations : Object.create(null);
  const key = workspaceKey(workspaceId);
  return hasOwn(integrations, key) && isObject(integrations[key])
    ? integrations[key]
    : Object.create(null);
}

function addAudit(db, action, actor) {
  if (!Array.isArray(db.audit)) db.audit = [];
  db.audit.unshift({
    id: id("audit"),
    action,
    actor: typeof actor === "string" && actor ? actor : "Unknown",
    createdAt: now(),
  });
}

export async function getIntegrationStatuses(workspaceId) {
  const db = await readDb();
  const stored = readStored(db, workspaceId);
  const slackUrl = ownString(hasOwn(stored, "slack") ? stored.slack : null, "webhookUrl");
  const zapierUrl = ownString(hasOwn(stored, "zapier") ? stored.zapier : null, "webhookUrl");
  return {
    slack: {
      configured: Boolean(slackUrl),
      webhookUrlMasked: slackUrl ? maskWebhookUrl(slackUrl) : "",
    },
    zapier: {
      configured: Boolean(zapierUrl),
      webhookUrlMasked: zapierUrl ? maskWebhookUrl(zapierUrl) : "",
    },
  };
}

export async function saveSlackWebhook(workspaceId, body, actor) {
  assertSafeKeys(body);
  if (!isObject(body)) throw badRequest("Invalid request body");
  for (const key of Object.keys(body)) {
    if (key !== "slackWebhookUrl") throw badRequest("Unexpected configuration field");
  }
  const webhookUrl = validateSlackWebhookUrl(body.slackWebhookUrl);
  await mutateDb((db) => {
    const integrations = isObject(db.integrations) ? db.integrations : Object.create(null);
    for (const key of Object.keys(integrations)) {
      if (UNSAFE_KEYS.has(key)) delete integrations[key];
    }
    const key = workspaceKey(workspaceId);
    const current = hasOwn(integrations, key) && isObject(integrations[key])
      ? integrations[key]
      : Object.create(null);
    const next = Object.create(null);
    next.slack = {
      webhookUrl,
      updatedAt: now(),
      updatedBy: typeof actor === "string" && actor ? actor : "Unknown",
    };
    next.zapier = hasOwn(current, "zapier") && isObject(current.zapier)
      ? { ...current.zapier }
      : Object.create(null);
    integrations[key] = next;
    db.integrations = integrations;
    addAudit(db, "Slack integration configured", actor);
  });
  return getIntegrationStatuses(workspaceId);
}

export async function deleteSlackWebhook(workspaceId, actor) {
  await mutateDb((db) => {
    const integrations = isObject(db.integrations) ? db.integrations : Object.create(null);
    for (const key of Object.keys(integrations)) {
      if (UNSAFE_KEYS.has(key)) delete integrations[key];
    }
    const key = workspaceKey(workspaceId);
    const current = hasOwn(integrations, key) && isObject(integrations[key])
      ? integrations[key]
      : Object.create(null);
    const next = Object.create(null);
    next.slack = Object.create(null);
    next.zapier = hasOwn(current, "zapier") && isObject(current.zapier)
      ? { ...current.zapier }
      : Object.create(null);
    integrations[key] = next;
    db.integrations = integrations;
    addAudit(db, "Slack integration disconnected", actor);
  });
  return getIntegrationStatuses(workspaceId);
}

export async function testSlackWebhook(workspaceId) {
  const db = await readDb();
  const stored = readStored(db, workspaceId);
  const webhookUrl = ownString(hasOwn(stored, "slack") ? stored.slack : null, "webhookUrl");
  if (!webhookUrl) throw internalError("Slack is not configured", 400);
  validateSlackWebhookUrl(webhookUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Tunaxa integration check" }),
      signal: controller.signal,
    });
    if (!response || !response.ok) throw new Error("Slack test failed");
    return {
      success: true,
      configured: true,
      provider: "slack",
      message: "Slack webhook responded successfully.",
    };
  } catch {
    throw internalError("Slack webhook did not respond successfully.", 502);
  } finally {
    clearTimeout(timer);
  }
}
