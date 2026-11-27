import { hasOwn, sanitizeFieldKey } from "../../components/records/urlSecurity";

const WON_STAGES = new Set([
  "won",
  "closed_won",
  "closedwon",
  "deal_won",
  "dealwon",
]);

export type DealSnapshot = Record<string, unknown>;
export type WonStage = { key: string; probability?: number };

export function safeDealRecord(value: unknown): DealSnapshot {
  const result = Object.create(null) as DealSnapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const safe = sanitizeFieldKey(key);
    if (!safe || !hasOwn(source, key)) continue;
    result[safe] = source[key];
  }
  return result;
}

export function dealAmount(value: unknown): number | null {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount;
}

export function wonStageKey(
  stage: unknown,
  stages?: readonly WonStage[],
): string | null {
  if (typeof stage !== "string") return null;
  const key = stage.trim();
  if (!key) return null;
  const normalized = key.toLowerCase().replace(/[\s-]+/g, "_");
  if (WON_STAGES.has(normalized)) return key;
  if (stages?.some((item) => item.key === key && item.probability === 100)) {
    return key;
  }
  return null;
}

export function isWonTransition(
  previous: unknown,
  next: unknown,
  stages?: readonly WonStage[],
): boolean {
  return !wonStageKey(previous, stages) && wonStageKey(next, stages) !== null;
}

export function wonRevenue(
  rows: readonly unknown[],
  stages?: readonly WonStage[],
): { total: number; count: number } {
  let total = 0;
  let count = 0;
  for (const row of rows) {
    const record = safeDealRecord(row);
    const stage = hasOwn(record, "stage") ? record.stage : undefined;
    if (!wonStageKey(stage, stages)) continue;
    const amount = hasOwn(record, "value") ? dealAmount(record.value) : null;
    if (amount === null) continue;
    total += amount;
    count += 1;
  }
  if (!Number.isFinite(total)) return { total: 0, count: 0 };
  return { total, count };
}

export function resourceFromEvent(event: Event): string | null {
  const detail = safeDealRecord((event as CustomEvent).detail);
  if (!hasOwn(detail, "resource")) return null;
  return sanitizeFieldKey(detail.resource);
}
