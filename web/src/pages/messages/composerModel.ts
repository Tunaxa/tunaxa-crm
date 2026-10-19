export type ContactOption = { id: string; name: string; email: string };
export type MailTemplate = { id: string; name: string; subject: string; body: string };
export function emailAddress(value: string) {
  const address = value.trim().toLowerCase();
  return /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/u.test(address) ? address : "";
}
export const canSend = (role?: string) => ["admin", "member", "Owner", "owner"].includes(role || "");
export function contactOptions(value: unknown): ContactOption[] {
  const rows = Array.isArray(value) ? value : (value as { data?: unknown[] })?.data;
  if (!Array.isArray(rows)) throw new Error("Invalid contacts response");
  const seen = new Set<string>();
  return rows.flatMap(row => {
    if (!row || typeof row.id !== "string" || typeof row.email !== "string") return [];
    const email = emailAddress(row.email);
    if (!email || seen.has(email)) return []; seen.add(email);
    return [{ id: row.id, email, name: typeof row.name === "string" ? row.name : email }];
  });
}
export function mailTemplates(value: unknown): MailTemplate[] {
  if (!Array.isArray(value)) throw new Error("Invalid templates response");
  return value.filter(row => row && (!row.channel || String(row.channel).toLowerCase() === "email")).map(row => {
    if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.subject !== "string" || typeof row.body !== "string") throw new Error("Invalid template");
    return { id: row.id, name: row.name, subject: row.subject, body: row.body };
  });
}
export function emailLink(value: string) {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP or HTTPS link without embedded credentials.");
  return url.href;
}
export function sendPayload(to: string, subject: string, body: string, html: string, key: string, contact = "") {
  const address = emailAddress(to);
  if (!address) throw new Error("Enter one valid recipient email address.");
  if (!body.trim()) throw new Error("Write a message before sending.");
  if (!key) throw new Error("Cannot prepare the message. Reopen the composer.");
  if (html.length > 100000) throw new Error("This formatted message is too large.");
  return { channel: "Email" as const, to: address, subject: subject.trim(), body: body.trim(), html, contact, idempotencyKey: key };
}
export function confirmedMail(value: unknown, payload: ReturnType<typeof sendPayload>) {
  const message = value as Record<string, unknown>;
  if (!message || typeof message.id !== "string" || !message.id || emailAddress(String(message.to || "")) !== payload.to || message.subject !== payload.subject || message.body !== payload.body || !["Sent", "Saved", "Queued", "Failed"].includes(String(message.status))) throw new Error("Send could not be confirmed. Check the inbox before retrying.");
  if (message.status === "Failed") throw new Error("Delivery failed. Your draft is retained; check the provider settings before retrying.");
  return message as { id: string; status: string; [key: string]: unknown };
}
export function mailStatus(status: string) {
  return status === "Sent" ? "Email sent" : status === "Saved" ? "Email saved; the email provider is not configured" : "Email queued; delivery is pending";
}
