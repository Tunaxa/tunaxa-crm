export type Message = {
  id: string; channel: string; to: string; from: string; replyTo: string; subject: string; body: string;
  direction: string; status: string; read: boolean; createdAt: string; contact: string;
  openedAt: string; clickedAt: string; deliveredAt: string; error: string;
};
export type Thread = { key: string; peer: string; subject: string; messages: Message[]; latest: Message; unread: boolean };
export const inboxFilters = ["All", "Unread", "Sent", "Tracked"] as const;
export type InboxFilter = typeof inboxFilters[number];
export const canSendEmail = (role?: string) => ["admin", "member", "Owner", "owner"].includes(role || "");

export function parseMessage(value: unknown): Message {
  const row = value as Record<string, unknown>;
  if (!row || typeof row.id !== "string" || !row.id || typeof row.channel !== "string" || row.channel.toLowerCase() !== "email") throw new Error("Invalid email response");
  const text = (key: string) => typeof row[key] === "string" ? row[key] as string : "";
  return { id: row.id, channel: "Email", to: text("to"), from: text("from"), replyTo: text("replyTo"), subject: text("subject"), body: text("body"), direction: text("direction"), status: text("status"), read: row.read === true, createdAt: text("createdAt"), contact: text("contact"), openedAt: text("openedAt"), clickedAt: text("clickedAt"), deliveredAt: text("deliveredAt"), error: text("error") };
}

export async function fetchInbox(get: (path: string) => Promise<unknown>): Promise<Message[]> {
  const rows = new Map<string, Message>();
  let expectedTotal: number | undefined;
  for (let page = 1; page <= 500; page++) {
    const result = await get(`/messages?type=email&page=${page}&limit=50`) as { items?: unknown[]; total: number; page: number; limit: number; hasMore: boolean };
    if (!result || !Array.isArray(result.items) || !Number.isInteger(result.total) || result.total < 0 || result.page !== page || result.limit !== 50 || typeof result.hasMore !== "boolean") throw new Error("Invalid inbox response");
    expectedTotal ??= result.total;
    if (result.total !== expectedTotal) throw new Error("Inbox changed while loading. Refresh again.");
    for (const item of result.items) {
      const message = parseMessage(item);
      if (rows.has(message.id)) throw new Error("Inbox changed while loading. Refresh again.");
      rows.set(message.id, message);
    }
    if (!result.hasMore) {
      if (rows.size !== expectedTotal) throw new Error("Incomplete inbox response. Refresh again.");
      return [...rows.values()];
    }
    if (!result.items.length || rows.size >= expectedTotal) throw new Error("Incomplete inbox response. Refresh again.");
  }
  throw new Error("This inbox is too large to load completely. Ask your administrator for server-side conversation paging.");
}

export function mailbox(value: string) {
  if (/[\r\n,;]/u.test(value)) return "";
  const address = (value.match(/^[^<>]*<([^<>]+)>\s*$/u)?.[1] || value).trim().toLowerCase();
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(address) ? address : "";
}
export const isOutbound = (message: Message) => message.direction.toLowerCase() !== "inbound" && (message.direction.toLowerCase() === "outbound" || !message.from);
export const replyRecipient = (message: Message) => mailbox(isOutbound(message) ? message.to : message.replyTo || message.from);
export function baseSubject(value: string) {
  return value.trim().replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/iu, "").trim();
}
export const replySubject = (value: string) => `Re: ${baseSubject(value) || "(no subject)"}`;
const time = (message: Message) => Number.isFinite(Date.parse(message.createdAt)) ? Date.parse(message.createdAt) : 0;
export function buildThreads(messages: Message[]): Thread[] {
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const peer = replyRecipient(message), subject = baseSubject(message.subject).toLowerCase() || "(no subject)";
    // The current API has no canonical conversation id. Group by counterpart
    // and subject, but never combine messages whose counterpart is unknown.
    const key = peer ? JSON.stringify([peer, subject]) : `message:${message.id}`;
    const group = groups.get(key) || []; group.push(message); groups.set(key, group);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const sorted = [...rows].sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));
    const latest = sorted[sorted.length - 1];
    return { key, peer: replyRecipient(latest), subject: baseSubject(latest.subject) || "No subject", messages: sorted, latest, unread: sorted.some(row => !row.read) };
  }).sort((a, b) => time(b.latest) - time(a.latest) || a.key.localeCompare(b.key));
}
export function filterThreads(threads: Thread[], filter: InboxFilter, query: string) {
  const search = query.trim().toLowerCase();
  return threads.filter(thread => {
    if (filter === "Unread" && !thread.unread) return false;
    if (filter === "Sent" && !thread.messages.some(row => row.status === "Sent")) return false;
    if (filter === "Tracked" && !thread.messages.some(row => row.openedAt || row.clickedAt)) return false;
    return !search || thread.messages.some(row => [row.from, row.to, row.subject, row.body].some(value => value.toLowerCase().includes(search)));
  });
}

export function emailPayload(to: string, subject: string, body: string, idempotencyKey: string, contact = "") {
  const recipient = mailbox(to);
  if (!recipient) throw new Error("Enter one valid recipient email address");
  if (!body.trim()) throw new Error("Write a message before sending");
  if (!idempotencyKey) throw new Error("Cannot prepare this message. Reopen the composer.");
  return { channel: "Email" as const, to: recipient, subject: subject.trim(), body: body.trim(), contact, idempotencyKey };
}
export type EmailPayload = ReturnType<typeof emailPayload>;
export function assertEmailResponse(value: unknown, payload: EmailPayload) {
  const row = parseMessage(value);
  if (mailbox(row.to) !== payload.to || row.subject !== payload.subject || row.body !== payload.body || !["Sent", "Saved", "Queued", "Failed"].includes(row.status)) throw new Error("Email result could not be confirmed. Refresh before trying again.");
  return row;
}
export function deliveryLabel(message: Message) {
  if (message.status === "Sent") return "Email sent";
  if (message.status === "Saved") return "Email saved; the email provider is not configured";
  if (message.status === "Queued") return "Email queued; delivery is pending";
  return "Email delivery failed. Check the email provider settings before retrying.";
}
export function inboxError(failure: unknown, fallback: string) {
  const status = (failure as { status?: number })?.status;
  if (status === 401) return "Sign in again to access the inbox.";
  if (status === 403) return "You do not have permission to perform this inbox action.";
  if (status === 404) return "This message is no longer available. Refresh the inbox.";
  return fallback;
}
