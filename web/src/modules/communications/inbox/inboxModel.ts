import { canManageRecords } from "../../../components/records/rbac";
import {
  hasOwn,
  sanitizeFieldKey,
} from "../../../components/records/urlSecurity";

export type Message = {
  id: string;
  channel: string;
  to: string;
  from: string;
  replyTo: string;
  subject: string;
  body: string;
  direction: string;
  status: string;
  read: boolean;
  createdAt: string;
  contact: string;
  openedAt: string;
  openCount: number;
  clickedAt: string;
  clickCount: number;
  deliveredAt: string;
  error: string;
};

export type Thread = {
  key: string;
  peer: string;
  subject: string;
  messages: Message[];
  latest: Message;
  unread: boolean;
};

export type DeliveryStatus = "Sent" | "Saved" | "Queued" | "Failed";
export type InboxFilter = "All" | "Unread" | "Sent" | "Tracked";
export type EmailPayload = {
  channel: "Email";
  to: string;
  subject: string;
  body: string;
  contact: string;
  idempotencyKey: string;
};
export type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
};

export const inboxFilters: readonly InboxFilter[] = [
  "All",
  "Unread",
  "Sent",
  "Tracked",
];
export const deliveryStatuses: readonly DeliveryStatus[] = [
  "Sent",
  "Saved",
  "Queued",
  "Failed",
];
const sentStatuses = new Set<string>(["Sent", "Saved", "Queued"]);

const PAGE_LIMIT = 50;
const MAX_PAGES = 500;
const MAX_TOTAL = PAGE_LIMIT * MAX_PAGES;
const MAX_SUBJECT = 255;
const MAX_BODY = 20000;
const messageFields = Object.freeze([
  "id",
  "channel",
  "to",
  "from",
  "replyTo",
  "subject",
  "body",
  "direction",
  "status",
  "createdAt",
  "contact",
  "openedAt",
  "clickedAt",
  "deliveredAt",
  "error",
] as const);
const messageCountFields = Object.freeze(["openCount", "clickCount"] as const);
const messageKeys = new Set<string>([...messageFields, ...messageCountFields]);
const payloadFields = Object.freeze([
  "channel",
  "to",
  "subject",
  "body",
  "contact",
  "idempotencyKey",
] as const);
const payloadKeys = new Set<string>(payloadFields);
const templateFields = Object.freeze([
  "id",
  "name",
  "subject",
  "body",
  "channel",
] as const);
const templateKeys = new Set<string>(templateFields);

export const canSendEmail = canManageRecords;

function isPageNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function normalizeDeliveryStatus(value: unknown): string {
  const status = typeof value === "string" ? value.trim() : "";
  const match = deliveryStatuses.find(
    (item) => item.toLowerCase() === status.toLowerCase(),
  );
  return match ?? status;
}

function readOwnText(
  row: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
): string {
  const safeKey = sanitizeFieldKey(key, allowed);
  if (!safeKey || !hasOwn(row, safeKey)) return "";
  const value = row[safeKey];
  return typeof value === "string" ? value : "";
}

function readOwnTimestamp(
  row: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
): string {
  const value = readOwnText(row, key, allowed);
  return value && Number.isFinite(Date.parse(value)) ? value : "";
}

function readOwnCount(
  row: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
): number {
  const safeKey = sanitizeFieldKey(key, allowed);
  if (!safeKey || !hasOwn(row, safeKey)) return 0;
  const raw = row[safeKey];
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

export function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export const dateLabel = (value: string) =>
  validDate(value) ? new Date(value).toLocaleString() : "Date unavailable";
export const dateTime = (value: string) => (validDate(value) ? value : undefined);

export function parseMessage(value: unknown): Message {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid email response");
  }
  const row = value as Record<string, unknown>;
  const fields = Object.create(null) as Record<string, string>;
  const counts = Object.create(null) as Record<string, number>;
  for (const key of messageFields) {
    fields[key] = readOwnText(row, key, messageKeys);
  }
  for (const key of messageCountFields) {
    counts[key] = readOwnCount(row, key, messageKeys);
  }
  if (!fields.id || fields.channel.toLowerCase() !== "email") {
    throw new Error("Invalid email response");
  }
  return {
    id: fields.id,
    channel: "Email",
    to: fields.to,
    from: fields.from,
    replyTo: fields.replyTo,
    subject: fields.subject,
    body: fields.body,
    direction: fields.direction,
    status: normalizeDeliveryStatus(fields.status),
    read: hasOwn(row, "read") && row.read === true,
    createdAt: fields.createdAt,
    contact: fields.contact,
    openedAt: readOwnTimestamp(row, "openedAt", messageKeys),
    openCount: counts.openCount,
    clickedAt: readOwnTimestamp(row, "clickedAt", messageKeys),
    clickCount: counts.clickCount,
    deliveredAt: readOwnTimestamp(row, "deliveredAt", messageKeys),
    error: fields.error,
  };
}

type InboxResponse = {
  data?: unknown;
  total?: unknown;
  page?: unknown;
  limit?: unknown;
};

export async function fetchInbox(
  get: (path: string) => Promise<unknown>,
): Promise<Message[]> {
  const rows = new Map<string, Message>();
  const limit = PAGE_LIMIT;
  let expectedTotal: number | undefined;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await get(
      `/messages?type=email&page=${page}&limit=${limit}`,
    );
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Invalid inbox response");
    }
    const envelope = result as InboxResponse;
    if (
      !hasOwn(envelope, "data") ||
      !Array.isArray(envelope.data) ||
      !hasOwn(envelope, "total") ||
      !isPageNumber(envelope.total) ||
      envelope.total > MAX_TOTAL ||
      !hasOwn(envelope, "page") ||
      envelope.page !== page ||
      !hasOwn(envelope, "limit") ||
      envelope.limit !== limit
    ) {
      throw new Error("Invalid inbox response");
    }
    const total = envelope.total;
    expectedTotal ??= total;
    if (total !== expectedTotal) {
      throw new Error("Inbox changed while loading. Refresh again.");
    }

    for (const item of envelope.data) {
      const message = parseMessage(item);
      if (rows.has(message.id)) {
        throw new Error("Inbox changed while loading. Refresh again.");
      }
      rows.set(message.id, message);
    }

    const hasMore = page * limit < total;
    if (!hasMore) {
      if (rows.size !== expectedTotal) {
        throw new Error("Incomplete inbox response. Refresh again.");
      }
      return [...rows.values()];
    }
    if (!envelope.data.length || rows.size >= expectedTotal) {
      throw new Error("Incomplete inbox response. Refresh again.");
    }
  }

  throw new Error(
    "This inbox is too large to load completely. Ask your administrator for server-side conversation paging.",
  );
}

export function parseEmailTemplates(value: unknown): EmailTemplate[] {
  const envelope = value && !Array.isArray(value) ? (value as InboxResponse) : null;
  const rows = Array.isArray(value) ? value : envelope?.data;
  if (!Array.isArray(rows)) throw new Error("Invalid templates response");
  if (envelope) {
    for (const key of ["total", "page", "limit"]) {
      if (hasOwn(envelope, key) && !isPageNumber(envelope[key as keyof InboxResponse])) {
        throw new Error("Invalid templates response");
      }
    }
  }

  return rows
    .filter((row) => !!row && typeof row === "object" && !Array.isArray(row))
    .map((row) => row as Record<string, unknown>)
    .filter((row) => {
      const channel = readOwnText(row, "channel", templateKeys);
      return !!readOwnText(row, "id", templateKeys) &&
        (!channel || channel.toLowerCase() === "email");
    })
    .map((row) => {
      const fields = Object.create(null) as Record<string, string>;
      for (const key of templateFields) {
        fields[key] = readOwnText(row, key, templateKeys);
      }
      return {
        id: fields.id,
        name: fields.name || "Untitled template",
        subject: fields.subject,
        body: fields.body,
      };
    });
}

export function mailbox(value: string): string {
  if (typeof value !== "string" || /[\r\n\u0000-\u001F\u007F,;]/u.test(value)) {
    return "";
  }
  const address =
    (value.match(/^[^<>]*<([^<>]+)>\s*$/u)?.[1] || value).trim().toLowerCase();
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(address) ? address : "";
}

export const isOutbound = (message: Message): boolean =>
  message.direction.toLowerCase() !== "inbound" &&
  (message.direction.toLowerCase() === "outbound" || !message.from);

export const replyRecipient = (message: Message): string =>
  mailbox(isOutbound(message) ? message.to : message.replyTo || message.from);

export function baseSubject(value: string): string {
  return value.trim().replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/iu, "").trim();
}

export const replySubject = (value: string): string =>
  `Re: ${baseSubject(value) || "(no subject)"}`;

const time = (message: Message): number =>
  Number.isFinite(Date.parse(message.createdAt)) ? Date.parse(message.createdAt) : 0;

export function groupMessagesIntoThreads(messages: Message[]): Thread[] {
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const peer = replyRecipient(message);
    const subject = baseSubject(message.subject).toLowerCase() || "(no subject)";
    const key = peer ? JSON.stringify([peer, subject]) : `message:${message.id}`;
    const group = groups.get(key) || [];
    group.push(message);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, rows]) => {
      const sorted = [...rows].sort(
        (a, b) => time(a) - time(b) || a.id.localeCompare(b.id),
      );
      const latest = sorted[sorted.length - 1];
      return {
        key,
        peer: replyRecipient(latest),
        subject: baseSubject(latest.subject) || "No subject",
        messages: sorted,
        latest,
        unread: sorted.some((row) => !row.read),
      };
    })
    .sort(
      (a, b) =>
        time(b.latest) - time(a.latest) || a.key.localeCompare(b.key),
    );
}

export const buildThreads = groupMessagesIntoThreads;

export function filterThreads(
  threads: Thread[],
  filter: InboxFilter,
  query: string,
): Thread[] {
  const search = query.trim().toLowerCase();
  return threads.filter((thread) => {
    if (filter === "Unread" && !thread.unread) return false;
    if (
      filter === "Sent" &&
      !thread.messages.some(
        (row) =>
          isOutbound(row) && sentStatuses.has(normalizeDeliveryStatus(row.status)),
      )
    ) {
      return false;
    }
    if (
      filter === "Tracked" &&
      !thread.messages.some((row) => row.openedAt || row.clickedAt)
    ) {
      return false;
    }
    return (
      !search ||
      thread.messages.some((row) =>
        [row.from, row.to, row.subject, row.body].some((value) =>
          value.toLowerCase().includes(search),
        ),
      )
    );
  });
}

export function buildEmailPayload(
  to: string,
  subject: string,
  body: string,
  idempotencyKey: string,
  contact = "",
): EmailPayload {
  const recipient = mailbox(to);
  if (!recipient) throw new Error("Enter one valid recipient email address");
  const safeSubject = subject.trim();
  if (/[\u0000-\u001F\u007F]/u.test(safeSubject)) {
    throw new Error("Subject contains invalid characters");
  }
  if (safeSubject.length > MAX_SUBJECT) {
    throw new Error("Subject must be 255 characters or fewer");
  }
  const safeBody = body.trim();
  if (!safeBody) throw new Error("Write a message before sending");
  if (safeBody.length > MAX_BODY) {
    throw new Error("Message must be 20000 characters or fewer");
  }
  if (!idempotencyKey) {
    throw new Error("Cannot prepare this message. Reopen the composer.");
  }

  const values = Object.create(null) as Record<string, string>;
  values.channel = "Email";
  values.to = recipient;
  values.subject = safeSubject;
  values.body = safeBody;
  values.contact = contact.trim();
  values.idempotencyKey = idempotencyKey;

  const payload = Object.create(null) as Record<string, unknown>;
  for (const key of payloadFields) {
    const safeKey = sanitizeFieldKey(key, payloadKeys);
    if (!safeKey || !hasOwn(values, safeKey)) {
      throw new Error("Invalid email payload");
    }
    payload[safeKey] = values[safeKey];
  }
  return payload as unknown as EmailPayload;
}

export const emailPayload = buildEmailPayload;

export function assertEmailResponse(
  value: unknown,
  payload: EmailPayload,
): Message {
  const row = parseMessage(value);
  const sameRecipient = mailbox(row.to) === mailbox(payload.to);
  const sameSubject = row.subject.trim() === payload.subject.trim();
  const sameBody = row.body.trim() === payload.body.trim();
  const knownStatus = (deliveryStatuses as readonly string[]).includes(
    normalizeDeliveryStatus(row.status),
  );
  if (!sameRecipient || !sameSubject || !sameBody || !knownStatus) {
    throw new Error(
      "Email result could not be confirmed. Refresh before trying again.",
    );
  }
  return row;
}

export function deliveryLabel(message: Message): string {
  const status = normalizeDeliveryStatus(message.status);
  if (status === "Sent") return "Email sent";
  if (status === "Saved") {
    return "Email saved; the email provider is not configured";
  }
  if (status === "Queued") return "Email queued; delivery is pending";
  return "Email delivery failed. Check the email provider settings before retrying.";
}

export function inboxError(failure: unknown, fallback: string): string {
  const status = (failure as { status?: number })?.status;
  if (status === 401) return "Sign in again to access the inbox.";
  if (status === 403) {
    return "You do not have permission to perform this inbox action.";
  }
  if (status === 404) {
    return "This message is no longer available. Refresh the inbox.";
  }
  return fallback;
}
