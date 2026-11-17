import type { FilterCondition, FilterGroup } from "../components/FilterBuilder";

// Mirrors backend/db/legacy-shape.js PG_RESOURCES. The list route rejects
// advanced `filters` payloads for these resources with a 400, so the UI must
// evaluate those groups locally instead of sending them over the wire.
export const PG_FILTER_RESOURCES = new Set([
  "contacts",
  "leads",
  "companies",
  "deals",
  "tasks",
  "activities",
  "products",
  "quotes",
  "contracts",
  "orders",
  "invoices",
  "expenses",
  "campaigns",
  "emailLists",
  "email_lists",
  "forms",
  "tickets",
  "surveys",
  "surveyResponses",
  "survey_responses",
  "goals",
  "savedReports",
  "saved_reports",
]);

// Exactly the operators/keys accepted by backend/services/queryFilter.js.
const SUPPORTED_OPERATORS = new Set([
  "eq",
  "neq",
  "contains",
  "starts_with",
  "gt",
  "lt",
  "is_set",
]);
const OPERATORS_WITHOUT_VALUE = new Set(["is_set"]);
const BANNED_FIELDS = new Set(["__proto__", "constructor", "prototype"]);
const CONDITION_KEYS = new Set(["field", "operator", "value"]);

type UnknownRecord = Record<string, unknown>;

function isValidCondition(value: unknown): value is FilterCondition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const condition = value as UnknownRecord;

  if (Object.keys(condition).some((key) => !CONDITION_KEYS.has(key))) return false;
  if (
    typeof condition.field !== "string" ||
    condition.field.trim() === "" ||
    BANNED_FIELDS.has(condition.field)
  )
    return false;
  if (
    typeof condition.operator !== "string" ||
    !SUPPORTED_OPERATORS.has(condition.operator)
  )
    return false;

  if (OPERATORS_WITHOUT_VALUE.has(condition.operator)) return true;

  // Blank/missing values are what make parseFilters answer 400. Drop them
  // before serialization so an incomplete rule never reaches the server.
  if (!("value" in condition)) return false;
  const filterValue = condition.value;
  if (filterValue === undefined || filterValue === null) return false;
  if (typeof filterValue === "string") return filterValue.trim() !== "";
  return (
    (typeof filterValue === "number" && Number.isFinite(filterValue)) ||
    typeof filterValue === "boolean"
  );
}

/**
 * Returns a group containing only complete, backend-valid conditions, or null
 * when nothing usable remains. The result is safe to JSON.stringify into the
 * `filters` query parameter and satisfies resources.js's parseFilters schema.
 */
export function sanitizeFilterGroup(
  group: FilterGroup | null | undefined,
): FilterGroup | null {
  if (!group || typeof group !== "object") return null;
  const source = group as UnknownRecord;
  const key: "$and" | "$or" | null =
    "$and" in source ? "$and" : "$or" in source ? "$or" : null;
  if (!key) return null;

  const branches = source[key];
  if (!Array.isArray(branches)) return null;

  const conditions = branches.filter(isValidCondition);
  if (conditions.length === 0) return null;

  return key === "$and" ? { $and: conditions } : { $or: conditions };
}

const isBlank = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as UnknownRecord).length === 0);

const isPresent = (row: UnknownRecord, field: string): boolean =>
  Object.prototype.hasOwnProperty.call(row, field) && !isBlank(row[field]);

const NUMERIC = /^-?\d+(\.\d+)?$/;

function toComparable(value: unknown): { kind: "number" | "text"; value: number | string } | null {
  if (typeof value === "number")
    return Number.isFinite(value) ? { kind: "number", value } : null;
  if (typeof value !== "string") return null;

  const text = value.trim();
  if (NUMERIC.test(text)) return { kind: "number", value: Number(text) };
  if (/[-/:]/.test(text)) {
    const time = Date.parse(text);
    if (!Number.isNaN(time)) return { kind: "number", value: time };
  }
  return { kind: "text", value };
}

function compareValues(actual: unknown, expected: unknown): number | null {
  const left = toComparable(actual);
  const right = toComparable(expected);
  if (!left || !right || left.kind !== right.kind) return null;
  if (left.value === right.value) return 0;
  return left.value < right.value ? -1 : 1;
}

const asText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value).toLowerCase();

function matchesCondition(row: UnknownRecord, condition: FilterCondition): boolean {
  const actual = row[condition.field];
  switch (condition.operator) {
    case "eq":
      return actual === condition.value;
    case "neq":
      return actual !== condition.value;
    case "contains": {
      const left = asText(actual);
      const right = asText(condition.value);
      return left !== null && right !== null && left.includes(right);
    }
    case "starts_with": {
      const left = asText(actual);
      const right = asText(condition.value);
      return left !== null && right !== null && left.startsWith(right);
    }
    case "gt":
      return compareValues(actual, condition.value) === 1;
    case "lt":
      return compareValues(actual, condition.value) === -1;
    case "is_set":
      return isPresent(row, condition.field);
    default:
      return true;
  }
}

/** Applies a sanitized FilterGroup locally (used for PG-backed resources). */
export function applyFilterGroup<T>(rows: T[], group: FilterGroup | null): T[] {
  const clean = sanitizeFilterGroup(group);
  if (!clean) return rows;

  const key: "$and" | "$or" = "$and" in clean ? "$and" : "$or";
  const conditions = (clean as UnknownRecord)[key] as FilterCondition[];
  return rows.filter((row) => {
    const matches = conditions.map((condition) =>
      matchesCondition(row as unknown as UnknownRecord, condition),
    );
    return key === "$and" ? matches.every(Boolean) : matches.some(Boolean);
  });
}
