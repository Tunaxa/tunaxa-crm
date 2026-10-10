// Unified list-query contract for collection endpoints (P2-BE1-02).
//
// Every list endpoint accepts the same four controls:
//
//   page    integer >= 1        (default 1)
//   limit   integer 1..100      (default 20)
//   sortBy  field name          (default "createdAt")
//   sortDir "asc" | "desc"      (default "desc")
//
// The helpers here are dependency-free so the generic resource router and the
// dedicated list routes can share one implementation instead of each carrying
// its own parsing, defaults and bounds. They are deliberately forgiving:
// invalid input is clamped or replaced with the default rather than rejected,
// which preserves the behaviour legacy callers already rely on.
//
// The response envelope is opt-in (`?envelope=true`). The legacy
// `/api/:resource` contract is a bare JSON array and existing tests/clients
// depend on that, so the uniform envelope is layered on top rather than
// replacing it. See docs/api-query-params.md.

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const DEFAULT_SORT_BY = "createdAt";
export const DEFAULT_SORT_DIR = "desc";

const SORT_DIRECTIONS = new Set(["asc", "desc"]);

// Sort fields must look like a single identifier. This blocks property paths
// (`a.b`), bracket/index access, whitespace and SQL punctuation before the
// value ever reaches a repository, and the explicit deny-list closes off the
// prototype-pollution names that are otherwise valid identifiers.
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]*$/;
const FORBIDDEN_FIELDS = new Set(["__proto__", "constructor", "prototype"]);

/** Parse a strictly integer query value, or NaN. Rejects arrays/objects. */
function toInteger(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  // Query values can arrive as arrays when a param is repeated; never coerce
  // those (String([...]) would silently produce a bogus field name).
  return NaN;
}

/** `page` clamped to an integer >= 1. */
export function normalizePage(value, fallback = DEFAULT_PAGE) {
  const parsed = toInteger(value);
  return Number.isFinite(parsed) && parsed >= DEFAULT_PAGE ? parsed : fallback;
}

/** `limit` clamped to 1..max, falling back to `fallback` for bad input. */
export function normalizeLimit(
  value,
  { fallback = DEFAULT_LIMIT, max = MAX_LIMIT } = {},
) {
  const ceiling = Number.isInteger(max) && max >= 1 ? max : MAX_LIMIT;
  const floor = Math.min(
    Number.isInteger(fallback) && fallback >= 1 ? fallback : DEFAULT_LIMIT,
    ceiling,
  );
  const parsed = toInteger(value);
  if (!Number.isInteger(parsed) || parsed < 1) return floor;
  return Math.min(parsed, ceiling);
}

/**
 * A single safe field name. Accepts the legacy `field:direction` spelling and
 * keeps only the field half; callers combine it with the normalized direction.
 */
export function normalizeSortBy(value, fallback = DEFAULT_SORT_BY) {
  if (typeof value !== "string") return fallback;
  const field = value.split(":")[0].trim();
  if (!field || FORBIDDEN_FIELDS.has(field) || !SAFE_FIELD.test(field)) {
    return fallback;
  }
  return field;
}

/** Case-insensitive direction normalised to `asc`/`desc`. */
export function normalizeSortDir(value, fallback = DEFAULT_SORT_DIR) {
  if (value === undefined || value === null) return fallback;
  const direction = String(value).trim().toLowerCase();
  return SORT_DIRECTIONS.has(direction) ? direction : fallback;
}

/**
 * Parse `req.query` (or any plain object) into the canonical list controls.
 * Repeated/array query values fall back to their defaults instead of leaking
 * arrays into repositories.
 */
export function normalizeListQuery(query = {}, options = {}) {
  const source = query && typeof query === "object" ? query : {};
  const rawSortBy = typeof source.sortBy === "string" ? source.sortBy : "";
  const [inlineField, inlineDir] = rawSortBy.includes(":")
    ? rawSortBy.split(":", 2)
    : [rawSortBy, undefined];

  return {
    page: normalizePage(source.page),
    limit: normalizeLimit(source.limit, {
      fallback: options.defaultLimit ?? DEFAULT_LIMIT,
      max: options.maxLimit ?? MAX_LIMIT,
    }),
    sortBy: normalizeSortBy(
      inlineField || rawSortBy,
      options.defaultSortBy ?? DEFAULT_SORT_BY,
    ),
    // An explicit `sortDir` wins over a direction carried inside `sortBy`.
    sortDir: normalizeSortDir(
      source.sortDir !== undefined ? source.sortDir : inlineDir,
      options.defaultSortDir ?? DEFAULT_SORT_DIR,
    ),
  };
}

/**
 * Translate the public camelCase controls into the `<column>:<direction>`
 * spelling the Postgres repositories expect. The repositories keep their own
 * per-resource column allow-list, so an unknown field degrades to their
 * default rather than being injected into SQL.
 */
export function toRepositorySort(sortBy, sortDir) {
  const column = String(sortBy || DEFAULT_SORT_BY)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return `${column}:${normalizeSortDir(sortDir)}`;
}

/** True when the caller opted into the uniform paged response envelope. */
export function wantsEnvelope(query = {}) {
  const raw = query && typeof query === "object" ? query.envelope : undefined;
  return raw === true || raw === "true" || raw === "1" || raw === "yes";
}

/**
 * The canonical pagination envelope: records under `data` plus the metadata a
 * paged client needs. `totalPages` is 0 for an empty result set.
 */
export function buildPaginationEnvelope(records, total, { page, limit } = {}) {
  const safeLimit = normalizeLimit(limit);
  const safeTotal = Number.isFinite(Number(total)) ? Number(total) : 0;
  return {
    data: Array.isArray(records) ? records : [],
    page: normalizePage(page),
    limit: safeLimit,
    total: safeTotal,
    totalPages: safeTotal <= 0 ? 0 : Math.ceil(safeTotal / safeLimit),
  };
}

/**
 * Stable in-memory sort for JSON-backed collections, mirroring the SQL
 * behaviour: missing/`null` values sort last regardless of direction.
 */
export function sortRecords(records, sortBy, sortDir) {
  const list = Array.isArray(records) ? records : [];
  const direction = normalizeSortDir(sortDir) === "asc" ? 1 : -1;
  const read = (record) =>
    record && typeof record === "object" ? record[sortBy] : undefined;

  return [...list].sort((a, b) => {
    const left = read(a);
    const right = read(b);
    if (left === right) return 0;
    if (left === undefined || left === null) return 1;
    if (right === undefined || right === null) return -1;
    if (typeof left === "number" && typeof right === "number") {
      return (left - right) * direction;
    }
    return (
      String(left).localeCompare(String(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }) * direction
    );
  });
}

/**
 * Express adapter: attaches the normalized controls to `req.pagination` so a
 * handler can read `{ page, limit, sortBy, sortDir }` directly.
 */
export function paginationMiddleware(options = {}) {
  return (req, res, next) => {
    req.pagination = normalizeListQuery(req.query, options);
    next();
  };
}
