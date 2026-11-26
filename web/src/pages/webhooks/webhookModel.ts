import { hasOwn, isSafeWebhookUrl, safeFields, sanitizeFieldKey } from "../../components/records/urlSecurity";

export type WebhookEndpoint = {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  created_at: string;
  hasSecret?: boolean;
};

type WebhookPayload = { url: string; events: string[] };

const DANGEROUS_EVENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SECRET_PATTERN = /^whsec_[a-f0-9]{64}$/u;

function readField(fields: Record<string, unknown>, key: string): unknown {
  const safeKey = sanitizeFieldKey(key);
  return safeKey && hasOwn(fields, safeKey) ? fields[safeKey] : undefined;
}

function readEventList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) {
    throw new Error("Enter at least one subscribed event.");
  }
  const seen = Object.create(null) as Record<string, true>;
  const events: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 100) {
      throw new Error("Invalid webhook endpoint response");
    }
    const event = entry.trim();
    if (DANGEROUS_EVENT_KEYS.has(event)) {
      throw new Error("Invalid webhook endpoint response");
    }
    if (hasOwn(seen, event)) continue;
    seen[event] = true;
    events.push(event);
  }
  return events;
}

export function webhookPayload(url: string, events: string): WebhookPayload {
  const address = url.trim();
  if (!isSafeWebhookUrl(address)) {
    throw new Error("Use a public HTTP or HTTPS endpoint URL without credentials or private hosts.");
  }
  return { url: address, events: readEventList(events.split(/[\n,]/u)) };
}

export function parseEndpoint(value: unknown): WebhookEndpoint {
  const fields = safeFields(value);
  const id = readField(fields, "id");
  const url = readField(fields, "url");
  const events = readEventList(readField(fields, "events"));
  const is_active = readField(fields, "is_active");
  const created_at = readField(fields, "created_at");
  const hasSecret = readField(fields, "hasSecret");

  if (
    typeof id !== "string" ||
    !id ||
    typeof url !== "string" ||
    !url ||
    typeof is_active !== "boolean"
  ) {
    throw new Error("Invalid webhook endpoint response");
  }

  const endpoint: WebhookEndpoint = {
    id,
    url,
    events,
    is_active,
    created_at: typeof created_at === "string" ? created_at : "",
  };
  if (typeof hasSecret === "boolean") endpoint.hasSecret = hasSecret;
  return endpoint;
}

export function parseEndpoints(value: unknown): WebhookEndpoint[] {
  const page = safeFields(value);
  const data = readField(page, "data");
  const total = readField(page, "total");
  if (!Array.isArray(data) || (total !== undefined && !Number.isInteger(total))) {
    throw new Error("Incomplete webhook list response");
  }

  const rows = data.map(parseEndpoint);
  const seen = Object.create(null) as Record<string, true>;
  for (const row of rows) {
    if (hasOwn(seen, row.id)) throw new Error("Duplicate webhook endpoints");
    seen[row.id] = true;
  }
  return rows;
}

export function webhookError(error: unknown, fallback: string): string {
  const status = (error as { status?: number } | null)?.status;
  if (status === 401) return "Sign in again to access webhook endpoints.";
  if (status === 403) return "You do not have permission to manage webhook endpoints.";
  if (status === 404) return "This webhook endpoint is no longer available. Refresh the list.";
  return fallback;
}

export function createdEndpoint(
  value: unknown,
  payload: WebhookPayload,
): { endpoint: WebhookEndpoint; secret: string | null } {
  const endpoint = parseEndpoint(value);
  const secret = readField(safeFields(value), "secret");
  if (
    endpoint.url !== payload.url ||
    JSON.stringify(endpoint.events) !== JSON.stringify(payload.events)
  ) {
    throw new Error("Webhook creation could not be confirmed");
  }
  return {
    endpoint,
    secret:
      typeof secret === "string" && SECRET_PATTERN.test(secret) ? secret : null,
  };
}

export function confirmedStatus(
  value: unknown,
  previous: WebhookEndpoint,
): WebhookEndpoint {
  const saved = parseEndpoint(value);
  if (saved.id !== previous.id || saved.is_active === previous.is_active) {
    throw new Error("Status update not confirmed");
  }
  return saved;
}
