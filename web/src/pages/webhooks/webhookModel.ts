export type WebhookEndpoint = { id: string; url: string; events: string[]; is_active: boolean; created_at: string };
export const canManageWebhooks = (role?: string) => ["admin", "member", "Owner", "owner"].includes(role || "");
export function webhookPayload(url: string, events: string) {
  const address = url.trim();
  let parsed: URL;
  try { parsed = new URL(address); } catch { throw new Error("Enter a valid HTTP or HTTPS endpoint URL."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Use an HTTP or HTTPS URL without embedded credentials.");
  const subscribed = [...new Set(events.split(/[\n,]/u).map(event => event.trim()).filter(Boolean))];
  if (!subscribed.length) throw new Error("Enter at least one subscribed event.");
  return { url: address, events: subscribed };
}
export function parseEndpoint(value: unknown): WebhookEndpoint {
  const row = value as Record<string, unknown>;
  if (!row || typeof row.id !== "string" || !row.id || typeof row.url !== "string" || !Array.isArray(row.events) || !row.events.length || row.events.some(event => typeof event !== "string" || !event.trim()) || typeof row.is_active !== "boolean") throw new Error("Invalid webhook endpoint response");
  return { id: row.id, url: row.url, events: row.events as string[], is_active: row.is_active, created_at: typeof row.created_at === "string" ? row.created_at : "" };
}
export function parseEndpoints(value: unknown): WebhookEndpoint[] {
  const page = value as { data?: unknown[]; total?: number };
  if (!page || !Array.isArray(page.data) || !Number.isInteger(page.total) || page.total !== page.data.length) throw new Error("Incomplete webhook list response");
  const rows = page.data.map(parseEndpoint);
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("Duplicate webhook endpoints");
  return rows;
}
export function webhookError(error: unknown, fallback: string) {
  const status = (error as { status?: number })?.status;
  if (status === 401) return "Sign in again to access webhook endpoints.";
  if (status === 403) return "You do not have permission to manage webhook endpoints.";
  if (status === 404) return "This webhook endpoint is no longer available. Refresh the list.";
  return fallback;
}
export function createdEndpoint(value: unknown, payload: ReturnType<typeof webhookPayload>) {
  const endpoint = parseEndpoint(value);
  if (endpoint.url !== payload.url || JSON.stringify(endpoint.events) !== JSON.stringify(payload.events)) throw new Error("Webhook creation could not be confirmed");
  const secret = (value as { secret?: unknown }).secret;
  return { endpoint, secret: typeof secret === "string" && /^whsec_[a-f0-9]{64}$/u.test(secret) ? secret : null };
}
export function confirmedStatus(value: unknown, previous: WebhookEndpoint) {
  const saved = parseEndpoint(value);
  if (saved.id !== previous.id || saved.is_active === previous.is_active) throw new Error("Status update not confirmed");
  return saved;
}
