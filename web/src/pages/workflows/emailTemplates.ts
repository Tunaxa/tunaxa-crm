export type EmailTemplate = { id: string; name: string; subject: string; body: string };
export function parseEmailTemplates(value: unknown): EmailTemplate[] {
  if (!Array.isArray(value)) throw new Error("Invalid templates response");
  const ids = new Set<string>();
  return value.filter(row => !row?.channel || String(row.channel).toLowerCase() === "email").map(row => {
    if (!row || typeof row.id !== "string" || !row.id || typeof row.name !== "string" || typeof row.subject !== "string" || typeof row.body !== "string" || ids.has(row.id)) throw new Error("Invalid email template");
    ids.add(row.id);
    return { id: row.id, name: row.name, subject: row.subject, body: row.body };
  });
}
export function templateParts(text: string) {
  return text.split(/(\{\{\s*[\w.]+\s*\}\})/gu).filter(Boolean).map(value => ({ value, mergeTag: /^\{\{\s*[\w.]+\s*\}\}$/u.test(value) }));
}
export const isSendEmail = (type: string) => ["email", "sendemail", "send_email"].includes(type.toLowerCase().replace(/\s+/gu, ""));
export function templateConfiguration(configuration: Record<string, unknown>, template: EmailTemplate | null) {
  const next = { ...configuration };
  if (template) return { ...next, templateId: template.id, subject: template.subject, body: template.body };
  delete next.templateId;
  // Clearing a selector must not erase a custom action subject or body.
  return next;
}
