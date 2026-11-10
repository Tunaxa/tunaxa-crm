import { query } from "../pg.js";
import { buildUpdateStatement } from "./update-builder.js";
import { toJsonb } from "./json.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "name",
  "permalink",
  "enabled",
  "submission_count",
]);
const UPDATE_FIELDS = [
  "name",
  "title",
  "description",
  "permalink",
  "submit_to",
  "progressive",
  "redirect_url",
  "enabled",
  "fields",
  "settings",
  "created_by",
  "custom_fields",
];

function validatePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function getSort(sortBy) {
  const parts = typeof sortBy === "string" ? sortBy.split(":") : [];
  const direction = parts[1]?.toLowerCase();
  if (
    parts.length > 2 ||
    !SORT_COLUMNS.has(parts[0]) ||
    (parts.length === 2 && direction !== "asc" && direction !== "desc")
  ) {
    return { column: "created_at", direction: "DESC" };
  }
  return {
    column: parts[0],
    direction: direction === "asc" ? "ASC" : "DESC",
  };
}

function getSearchTerm(q) {
  if (q === undefined || q === null) return "";
  const value = String(q);
  return value.trim() ? `%${value}%` : "";
}

export async function findAll({
  page = 1,
  limit = 20,
  sortBy = "created_at:desc",
  q = "",
  enabled = "",
  submitTo = "",
  workspaceId,
} = {}) {
  const normalizedPage = validatePositiveInteger(page, "page");
  const normalizedLimit = Math.min(
    validatePositiveInteger(limit, "limit"),
    100,
  );
  const offset = (normalizedPage - 1) * normalizedLimit;
  const searchTerm = getSearchTerm(q);
  const { column, direction } = getSort(sortBy);
  const conditions = [];
  const params = [];
  if (workspaceId !== undefined && workspaceId !== null) {
    params.push(workspaceId);
    conditions.push(
      `(workspace_id = $${params.length} OR ($${params.length} = 'default' AND workspace_id IS NULL))`,
    );
  }
  if (searchTerm) {
    params.push(searchTerm);
    const p = `$${params.length}`;
    conditions.push(
      `(name ILIKE ${p} OR title ILIKE ${p} OR permalink ILIKE ${p} OR description ILIKE ${p})`,
    );
  }
  // `enabled` arrives as a query string, and "false" is truthy in SQL, so it has
  // to be compared as a boolean or the filter would select disabled forms.
  if (enabled !== undefined && enabled !== null && enabled !== "") {
    params.push(enabled === true || enabled === "true");
    conditions.push(`enabled = $${params.length}`);
  }
  const submitToFilter = String(submitTo || "").trim().toLowerCase();
  if (submitToFilter) {
    params.push(submitToFilter);
    conditions.push(`LOWER(COALESCE(submit_to, '')) = $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM forms
     ${whereClause}`,
    [...params],
  );
  const params2 = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT *
     FROM forms
     ${whereClause}
     ORDER BY ${column} ${direction}
     LIMIT $${params2.length - 1} OFFSET $${params2.length}`,
    params2,
  );
  const total = Number(countResult.rows[0]?.total ?? 0);
  return {
    data: dataResult.rows,
    total,
    page: normalizedPage,
    limit: normalizedLimit,
    totalPages: Math.ceil(total / normalizedLimit),
  };
}

export async function findById(id, workspaceId) {
  // The workspace predicate lives in the WHERE clause, not in a post-filter: a
  // record belonging to another tenant has to be indistinguishable from one
  // that does not exist.
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "SELECT * FROM forms WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL))"
      : "SELECT * FROM forms WHERE id = $1",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rows[0] || null;
}

/**
 * Public form lookup. The permalink is the route key for
 * `GET /api/forms/:permalink` and its submit handler, and a disabled form has
 * to be invisible to both, so the enabled check belongs in the query rather
 * than in a filter applied by the caller.
 */
export async function findByPermalink(permalink) {
  const result = await query(
    "SELECT * FROM forms WHERE permalink = $1 AND enabled IS NOT FALSE LIMIT 1",
    [permalink],
  );
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO forms (
       workspace_id, name, title, description, permalink, submit_to,
       progressive, redirect_url, enabled, fields, settings,
       submission_count, created_by, custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      data.workspace_id,
      data.name,
      data.title,
      data.description,
      data.permalink,
      data.submit_to,
      // LEFT as null when unset so the column DEFAULT TRUE applies.
      data.progressive === undefined ? null : data.progressive,
      data.redirect_url,
      data.enabled === undefined ? null : data.enabled,
      toJsonb(data.fields, []),
      toJsonb(data.settings, {}),
      data.submission_count === undefined ? null : data.submission_count,
      data.created_by,
      toJsonb(data.custom_fields, {}),
    ],
  );
  return result.rows[0] || null;
}

export async function update(id, data = {}, workspaceId) {
  const statement = buildUpdateStatement({
    id,
    table: "forms",
    allowedFields: UPDATE_FIELDS,
    data,
    workspaceId,
    jsonbFields: ["custom_fields", "fields", "settings"],
    jsonbFallback: {"custom_fields":"{}"},
  });
  if (!statement) return null;

  const result = await query(statement.sql, statement.values);
  return result.rows[0] || null;
}
/**
 * Bump the public submission counter.
 *
 * Deliberately does not touch updated_at: a submission is not an edit of the
 * form, and bumping the modified timestamp on every visitor would make the
 * form list churn and destroy the signal about when the form last changed.
 */
export async function incrementSubmissions(id) {
  const result = await query(
    `UPDATE forms
     SET submission_count = COALESCE(submission_count, 0) + 1
     WHERE id = $1
     RETURNING *`,
    [id],
  );
  return result.rows[0] || null;
}

async function remove(id, workspaceId) {
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "DELETE FROM forms WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL)) RETURNING id"
      : "DELETE FROM forms WHERE id = $1 RETURNING id",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rowCount > 0;
}

export { remove as delete };
