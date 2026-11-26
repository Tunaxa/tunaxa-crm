import {
  hasOwn,
  safeFields,
  sanitizeFieldKey,
} from "../../components/records/urlSecurity";

export type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
};

const TEMPLATE_KEYS = new Set([
  "id",
  "name",
  "subject",
  "body",
  "channel",
  "createdAt",
  "updatedAt",
]);

function templateRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const envelope = safeFields(value);

    if (hasOwn(envelope, "data") && Array.isArray(envelope.data)) {
      return envelope.data;
    }
  }

  throw new Error("Invalid templates response");
}

export function parseEmailTemplates(value: unknown): EmailTemplate[] {
  const rows = templateRows(value);
  const ids = new Set<string>();
  const templates: EmailTemplate[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Invalid email template");
    }

    const source = row as Record<string, unknown>;

    for (const key of Object.keys(source)) {
      if (!sanitizeFieldKey(key, TEMPLATE_KEYS) && hasOwn(source, key)) {
        throw new Error("Invalid email template");
      }
    }

    const safe = safeFields(source);
    const channel = typeof safe.channel === "string" ? safe.channel.toLowerCase() : "";

    if (channel && channel !== "email") continue;

    if (
      typeof safe.id !== "string" ||
      !safe.id ||
      typeof safe.name !== "string" ||
      typeof safe.subject !== "string" ||
      typeof safe.body !== "string" ||
      ids.has(safe.id)
    ) {
      throw new Error("Invalid email template");
    }

    const template = Object.create(null) as EmailTemplate;

    template.id = safe.id;
    template.name = safe.name;
    template.subject = safe.subject;
    template.body = safe.body;
    ids.add(template.id);
    templates.push(template);
  }

  return templates;
}

export function templateParts(text: string) {
  return text
    .split(/(\{\{\s*[\w.]+\s*\}\})/gu)
    .filter(Boolean)
    .map((value) => ({
      value,
      mergeTag: /^\{\{\s*[\w.]+\s*\}\}$/u.test(value),
    }));
}

export function isSendEmail(type: unknown): boolean {
  const normalized = String(type ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/gu, "");

  return normalized === "sendemail" || normalized === "email";
}

export function templateConfiguration(
  configuration: Record<string, unknown>,
  template: EmailTemplate | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...safeFields(configuration) };

  if (template) {
    return {
      ...next,
      templateId: template.id,
      subject: template.subject,
      body: template.body,
    };
  }

  delete next.templateId;

  return next;
}
