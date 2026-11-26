import type { FieldSpec } from "./types";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FIELD_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function sanitizeFieldKey(
  value: unknown,
  allowed?: ReadonlySet<string>,
): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.length > 100) return null;
  if (DANGEROUS_KEYS.has(key)) return null;
  if (key.includes(".") || key.includes("[") || key.includes("]")) return null;
  if (!FIELD_KEY_PATTERN.test(key)) return null;
  if (allowed && !allowed.has(key)) return null;
  return key;
}

export const sanitizeFormFieldKey = sanitizeFieldKey;

const NOTIFICATION_ROUTE_PATTERN =
  /^\/(?:contacts|leads|companies|deals|invoices|quotes|contracts)\/[A-Za-z0-9_-]+$/u;

export function containsDangerousKey(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).some((key) =>
    DANGEROUS_KEYS.has(key.trim()),
  );
}

export function safeFields(value: unknown): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const safe = sanitizeFieldKey(key);
    if (!safe || !hasOwn(source, key)) continue;
    result[safe] = source[key];
  }
  return result;
}

export function notificationTarget(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (/[\\\s%?#]/u.test(value) || value.startsWith("//")) return null;
  return NOTIFICATION_ROUTE_PATTERN.test(value) ? value : null;
}

function parseUrl(value: string, base: string): URL | null {
  if (CONTROL_CHARS.test(value)) return null;
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function isRootRelative(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");
}

function isSafeWebUrl(value: string, allowDataImage: boolean): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (allowDataImage && SAFE_DATA_IMAGE.test(trimmed)) return true;
  if (!isRootRelative(trimmed) && !/^https?:\/\//i.test(trimmed)) return false;
  const base =
    typeof window === "undefined" || !window.location?.origin
      ? "http://localhost"
      : window.location.origin;
  const url = parseUrl(trimmed, base);
  if (!url) return false;
  if (url.username || url.password) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (isRootRelative(trimmed) && url.origin !== parseUrl(base, base)?.origin) {
    return false;
  }
  return true;
}

export function isSafeMediaUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (SAFE_DATA_IMAGE.test(trimmed)) return true;
  return isSafeWebUrl(trimmed, false);
}

export function safeMediaSrc(value: unknown): string {
  return typeof value === "string" && isSafeMediaUrl(value) ? value.trim() : "";
}

export function isSafeRedirectUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return isSafeWebUrl(trimmed, false);
}

export function safeRedirectUrl(value: unknown): string {
  return typeof value === "string" && isSafeRedirectUrl(value) ? value.trim() : "";
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  rows.push(row);
  return rows.filter((entry) => entry.some((value) => value !== ""));
}

export function sanitizeCsvRecords(
  text: string,
  allowedKeys: readonly string[],
): { records: Record<string, string>[]; rejectedHeaders: string[]; skippedRows: number } {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { records: [], rejectedHeaders: [], skippedRows: 0 };
  }
  const allowed = new Set(
    allowedKeys
      .map((key) => sanitizeFieldKey(key))
      .filter((key): key is string => Boolean(key)),
  );
  const canonical = new Map<string, string>();
  const rejectedHeaders: string[] = [];
  rows[0].forEach((header) => {
    const direct = sanitizeFieldKey(header, allowed);
    if (direct) {
      canonical.set(header, direct);
      return;
    }
    const match = [...allowed].find((key) => key.toLowerCase() === header.trim().toLowerCase());
    if (match) canonical.set(header, match);
    else rejectedHeaders.push(header);
  });
  const keys = rows[0].map((header) => canonical.get(header)).filter(
    (key): key is string => Boolean(key),
  );
  if (!keys.length) {
    return { records: [], rejectedHeaders, skippedRows: rows.length - 1 };
  }
  const records: Record<string, string>[] = [];
  let skippedRows = 0;
  for (const values of rows.slice(1)) {
    const seen = Object.create(null) as Record<string, true>;
    const record: Record<string, string> = {};
    keys.forEach((key, index) => {
      if (hasOwn(seen, key)) return;
      seen[key] = true;
      record[key] = values[index] ?? "";
    });
    if (Object.keys(record).length) records.push(record);
    else skippedRows += 1;
  }
  return { records, rejectedHeaders, skippedRows };
}

export function sanitizeFormValues(
  values: Record<string, unknown> | undefined,
  fields: readonly FieldSpec[],
): Record<string, unknown> {
  const allowed = new Set(
    fields
      .map((field) => sanitizeFieldKey(field.key))
      .filter((key): key is string => Boolean(key)),
  );
  const result: Record<string, unknown> = {};
  if (!values || typeof values !== "object") return result;
  for (const field of fields) {
    const key = sanitizeFieldKey(field.key, allowed);
    if (!key || !hasOwn(values, key)) continue;
    const value = values[key];
    if (field.type === "photo") {
      result[key] = safeMediaSrc(value);
      continue;
    }
    if (field.type === "checkbox") {
      result[key] = Boolean(value);
      continue;
    }
    if (field.type === "number") {
      const number = Number(value);
      result[key] = Number.isFinite(number) ? number : "";
      continue;
    }
    if (field.type === "select" && field.options?.length) {
      result[key] = field.options.includes(String(value)) ? String(value) : field.options[0];
      continue;
    }
    if (typeof value === "string" && value.length > 5000) {
      result[key] = value.slice(0, 5000);
      continue;
    }
    result[key] = value;
  }
  return result;
}
