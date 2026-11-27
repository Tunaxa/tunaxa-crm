import {
  hasOwn,
  sanitizeFieldKey,
} from "../../components/records/urlSecurity";

export type ContactEmailAnalytics = {
  contactId: string;
  sentEmails: number;
  openedEmails: number;
  totalOpens: number;
  clickCount: number;
  openRate: number;
  lastOpenedAt: string;
};

const analyticsKeys = Object.freeze([
  "contactId",
  "sentEmails",
  "openedEmails",
  "totalOpens",
  "clickCount",
  "openRate",
  "lastOpenedAt",
] as const);
const allowedKeys = new Set<string>(analyticsKeys);

function readOwn(
  row: Record<string, unknown>,
  key: string,
): unknown {
  const safeKey = sanitizeFieldKey(key, allowedKeys);
  if (!safeKey || !hasOwn(row, key)) return undefined;
  return row[key];
}

function readText(
  row: Record<string, unknown>,
  key: string,
): string {
  const value = readOwn(row, key);
  return typeof value === "string" ? value : "";
}

function readCount(
  row: Record<string, unknown>,
  key: string,
): number {
  const raw = readOwn(row, key);
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

function readRate(
  row: Record<string, unknown>,
  key: string,
): number {
  const raw = readOwn(row, key);
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 100);
}

export function parseContactEmailAnalytics(value: unknown): ContactEmailAnalytics {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid email analytics response");
  }
  const root = value as Record<string, unknown>;
  if (!hasOwn(root, "data")) throw new Error("Invalid email analytics response");
  const source = root.data;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Invalid email analytics response");
  }
  const sourceRow = source as Record<string, unknown>;

  const fields = Object.create(null) as Record<string, unknown>;
  for (const key of analyticsKeys) {
    const safeKey = sanitizeFieldKey(key, allowedKeys);
    if (safeKey && hasOwn(sourceRow, key)) fields[safeKey] = sourceRow[key];
  }

  const contactId = readText(fields, "contactId");
  if (!contactId) throw new Error("Invalid email analytics response");

  const sentEmails = readCount(fields, "sentEmails");
  const openedEmails = Math.min(readCount(fields, "openedEmails"), sentEmails);
  const totalOpens = readCount(fields, "totalOpens");
  const clickCount = readCount(fields, "clickCount");
  const reportedRate = readRate(fields, "openRate");
  const computedRate =
    sentEmails > 0 ? Math.round((openedEmails / sentEmails) * 1000) / 10 : 0;
  const openRate = reportedRate > 0 ? reportedRate : computedRate;
  const lastOpenedAt = readText(fields, "lastOpenedAt");

  return {
    contactId,
    sentEmails,
    openedEmails,
    totalOpens,
    clickCount,
    openRate,
    lastOpenedAt: Number.isFinite(Date.parse(lastOpenedAt)) ? lastOpenedAt : "",
  };
}
