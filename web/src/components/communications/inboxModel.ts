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
  clickedAt: string;
  deliveredAt: string;
  error: string;
};

export const deliveryStatuses = ["Sent", "Saved", "Queued", "Failed"] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

const sendableRoles = new Set(["owner", "admin", "member"]);

export function canSendEmail(role?: string): boolean {
  return sendableRoles.has(String(role ?? "").trim().toLowerCase());
}

function normalizeDeliveryStatus(value: string): string {
  const match = deliveryStatuses.find(
    (status) => status.toLowerCase() === value.trim().toLowerCase(),
  );
  return match ?? value;
}

export function parseMessage(value: unknown): Message {
  const row = value as Record<string, unknown>;
  if (
    !row ||
    typeof row.id !== "string" ||
    !row.id ||
    typeof row.channel !== "string" ||
    row.channel.toLowerCase() !== "email"
  ) {
    throw new Error("Invalid email response");
  }
  const text = (key: string) =>
    typeof row[key] === "string" ? (row[key] as string) : "";
  return {
    id: row.id,
    channel: "Email",
    to: text("to"),
    from: text("from"),
    replyTo: text("replyTo"),
    subject: text("subject"),
    body: text("body"),
    direction: text("direction"),
    status: normalizeDeliveryStatus(text("status")),
    read: row.read === true,
    createdAt: text("createdAt"),
    contact: text("contact"),
    openedAt: text("openedAt"),
    clickedAt: text("clickedAt"),
    deliveredAt: text("deliveredAt"),
    error: text("error"),
  };
}

type InboxPage = {
  data?: unknown;
  total?: unknown;
  page?: unknown;
  limit?: unknown;
};

/**
 * Dev's generic /api/messages list is paginated with
 * `{ data, total, page, limit }` and has no `items`/`hasMore` fields.
 */
export async function fetchInbox(
  get: (path: string) => Promise<unknown>,
): Promise<Message[]> {
  const rows = new Map<string, Message>();
  const limit = 50;
  let expectedTotal: number | undefined;

  for (let page = 1; page <= 500; page += 1) {
    const result = (await get(
      `/messages?type=email&page=${page}&limit=${limit}`,
    )) as InboxPage;
    if (
      !result ||
      !Array.isArray(result.data) ||
      !Number.isInteger(result.total) ||
      (result.total as number) < 0 ||
      result.page !== page ||
      result.limit !== limit
    ) {
      throw new Error("Invalid inbox response");
    }
    const total = result.total as number;
    expectedTotal ??= total;
    if (total !== expectedTotal) {
      throw new Error("Inbox changed while loading. Refresh again.");
    }

    for (const item of result.data) {
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
    if (!result.data.length || rows.size >= expectedTotal) {
      throw new Error("Incomplete inbox response. Refresh again.");
    }
  }

  throw new Error(
    "This inbox is too large to load completely. Ask your administrator for server-side conversation paging.",
  );
}

export function mailbox(value: string) {
  if (/[\r\n,;]/u.test(value)) return "";
  const address =
    (value.match(/^[^<>]*<([^<>]+)>\s*$/u)?.[1] || value).trim().toLowerCase();
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(address) ? address : "";
}

export function emailPayload(
  to: string,
  subject: string,
  body: string,
  idempotencyKey: string,
  contact = "",
) {
  const recipient = mailbox(to);
  if (!recipient) throw new Error("Enter one valid recipient email address");
  if (!body.trim()) throw new Error("Write a message before sending");
  if (!idempotencyKey) {
    throw new Error("Cannot prepare this message. Reopen the composer.");
  }
  return {
    channel: "Email" as const,
    to: recipient,
    subject: subject.trim(),
    body: body.trim(),
    contact,
    idempotencyKey,
  };
}

export type EmailPayload = ReturnType<typeof emailPayload>;

export function assertEmailResponse(
  value: unknown,
  payload: EmailPayload,
): Message {
  const row = parseMessage(value);
  const sameRecipient = mailbox(row.to) === payload.to;
  const sameSubject = row.subject.trim() === payload.subject;
  const sameBody = row.body.trim() === payload.body;
  const knownStatus = (deliveryStatuses as readonly string[]).includes(
    row.status,
  );
  if (!sameRecipient || !sameSubject || !sameBody || !knownStatus) {
    throw new Error(
      "Email result could not be confirmed. Refresh before trying again.",
    );
  }
  return row;
}

export function deliveryLabel(message: Message): string {
  if (message.status === "Sent") return "Email sent";
  if (message.status === "Saved") {
    return "Email saved; the email provider is not configured";
  }
  if (message.status === "Queued") return "Email queued; delivery is pending";
  return "Email delivery failed. Check the email provider settings before retrying.";
}

export function inboxError(failure: unknown, fallback: string): string {
  const status = (failure as { status?: number })?.status;
  if (status === 401) return "Sign in again to access the inbox.";
  if (status === 403) {
    return "You do not have permission to perform this inbox action.";
  }
  if (status === 404) return "This message is no longer available. Refresh the inbox.";
  return fallback;
}
