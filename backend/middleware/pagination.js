// Defensive list-query helpers (P2-BE1-02).
//
// These helpers preserve the canonical dev contract: every list endpoint
// returns `{ data, total, page, limit }` with limit defaulting to 25 and capped
// at 100. They add three non-breaking defences on top of that contract:
//
//   1. Repeated / array-shaped list parameters are rejected with HTTP 400
//      instead of being coerced by String([...]) into a bogus value.
//   2. `sortBy` must be a single safe identifier. Prototype-pollution keys,
//      dotted property paths and SQL punctuation are replaced with the default.
//   3. Sorting and envelope construction are shared, stable helpers useful to
//      JSON-backed routes without changing their response shape.

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const DEFAULT_SORT_BY = "createdAt";
export const DEFAULT_SORT_DIR = "desc";

const SORT_DIRECTIONS = new Set(["asc", "desc"]);
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]*$/;
const FORBIDDEN_FIELDS = new Set(["__proto__", "constructor", "prototype"]);

// The list controls that must never arrive as an array. `order` and `search`
// are included as the common legacy aliases of sortDir and q.
const LIST_PARAMS = new Set([
  "page",
  "limit",
  "sortBy",
  "sortDir",
  "order",
  "q",
  "search",
]);

/** Error carrying an explicit 400 so dev's central error handler can map it. */
export class QueryParamError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueryParamError";
    this.status = 400;
  }
}

/**
 * Express' simple query parser turns `?page[]=1` into the literal key
 * `page[]`, while `?page=1&page=2` produces `page: ['1', '2']`. Both spellings
 * must be rejected, so resolve bracket/index notation back to the base name.
 */
function baseParamName(key) {
  const match = /^([A-Za-z][A-Za-z0-9_]*)\[(?:[^\]]*)\]$/.exec(key);
  return match ? match[1] : key;
}

/** Throw a 400 when any list control is repeated or array-shaped. */
export function assertNoArrayQueryParams(query) {
  if (!query || typeof query !== "object" || Array.isArray(query)) return;
  for (const [key, value] of Object.entries(query)) {
    const base = baseParamName(key);
    if (!LIST_PARAMS.has(base)) continue;
    const arrayShaped =
      Array.isArray(value) ||
      base !== key ||
      (value !== null && typeof value === "object");
    if (arrayShaped) {
      throw new QueryParamError(
        `Query parameter "${key}" must be a single value`,
      );
    }
  }
}

function toInteger(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

/** Page number, always an integer >= 1. */
export function normalizePage(value, fallback = DEFAULT_PAGE) {
  const parsed = toInteger(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/** Page size, clamped to 1..max with dev's default of 25. */
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
 * A single safe sort field. `allowedFields`, when supplied, is an additional
 * allowlist (array or Set); anything outside it falls back to `fallback`.
 */
export function normalizeSortBy(value, allowedFields, fallback = DEFAULT_SORT_BY) {
  if (typeof value !== "string") return fallback;
  // Accept the legacy `field:direction` spelling by keeping only the field.
  const field = value.split(":")[0].trim();
  if (!field || FORBIDDEN_FIELDS.has(field.toLowerCase())) return fallback;
  if (field.includes(".")) return fallback;
  if (!SAFE_FIELD.test(field)) return fallback;
  if (allowedFields) {
    const allowed =
      allowedFields instanceof Set ? allowedFields : new Set(allowedFields);
    if (!allowed.has(field)) return fallback;
  }
  return field;
}

/** Case-insensitive `asc`/`desc` normalization. */
export function normalizeSortDir(value, fallback = DEFAULT_SORT_DIR) {
  if (value === undefined || value === null) return fallback;
  const direction = String(value).trim().toLowerCase();
  return SORT_DIRECTIONS.has(direction) ? direction : fallback;
}

/**
 * Normalize a `req.query`-like object into the canonical list controls.
 * Array-shaped controls are rejected with a 400 error rather than clamped.
 */
export function normalizeListQuery(query = {}, options = {}) {
  assertNoArrayQueryParams(query);
  const source = query && typeof query === "object" ? query : {};
  const rawSortBy = typeof source.sortBy === "string" ? source.sortBy : "";
  const [inlineField, inlineDirection] = rawSortBy.includes(":")
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
      options.allowedFields,
      options.defaultSortBy ?? DEFAULT_SORT_BY,
    ),
    // An explicit sortDir (or its `order` alias) wins over the inline one.
    sortDir: normalizeSortDir(
      source.sortDir !== undefined
        ? source.sortDir
        : source.order !== undefined
          ? source.order
          : inlineDirection,
      options.defaultSortDir ?? DEFAULT_SORT_DIR,
    ),
  };
}

/**
 * Stable in-memory sort for JSON-backed collections: missing/null values sort
 * last in both directions, and equal values keep their input order.
 */
export function sortRecords(items, sortBy, sortDir) {
  const list = Array.isArray(items) ? items : [];
  const direction = normalizeSortDir(sortDir) === "asc" ? 1 : -1;
  const field = normalizeSortBy(sortBy);
  const read = (record) =>
    record && typeof record === "object" ? record[field] : undefined;

  return list
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const left = read(a.record);
      const right = read(b.record);
      if (left === right) return a.index - b.index;
      if (left === undefined || left === null) return 1;
      if (right === undefined || right === null) return -1;
      let result;
      if (typeof left === "number" && typeof right === "number") {
        result = left - right;
      } else {
        result = String(left).localeCompare(String(right), undefined, {
          numeric: true,
          sensitivity: "base",
        });
      }
      return result === 0 ? a.index - b.index : result * direction;
    })
    .map(({ record }) => record);
}

/**
 * The canonical list envelope plus `totalPages`. `dev` returns
 * `{ data, total, page, limit }`; this helper is additive and preserves those
 * keys unchanged.
 */
export function buildPaginationEnvelope({ data, total, page, limit } = {}) {
  const safeLimit = normalizeLimit(limit);
  const safeTotal = Number.isFinite(Number(total)) ? Number(total) : 0;
  return {
    data: Array.isArray(data) ? data : [],
    total: safeTotal,
    page: normalizePage(page),
    limit: safeLimit,
    totalPages: safeTotal <= 0 ? 0 : Math.ceil(safeTotal / safeLimit),
  };
}

/** Express guard: rejects repeated list controls before any route logic. */
export function paginationGuard() {
  return (req, res, next) => {
    try {
      assertNoArrayQueryParams(req.query);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/** Optional adapter for routes that want the normalized controls directly. */
export function paginationMiddleware(options = {}) {
  return (req, res, next) => {
    try {
      req.pagination = normalizeListQuery(req.query, options);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
