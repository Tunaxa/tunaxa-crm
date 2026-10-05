import { query } from "../pg.js";
import { buildUpdateStatement } from "./update-builder.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "first_name",
  "last_name",
  "email",
  "phone",
  "title",
]);
const UPDATE_FIELDS = [
  "company_id",
  "first_name",
  "last_name",
  "email",
  "phone",
  "title",
  "owner_id",
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
  // Ordered condition list so the workspace predicate can be prepended without
  // renumbering the search placeholders by hand.
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
      `(first_name ILIKE ${p} OR last_name ILIKE ${p} OR email ILIKE ${p} OR phone ILIKE ${p} OR title ILIKE ${p})`,
    );
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM contacts
     ${whereClause}`,
    [...params],
  );
  const params2 = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT *
     FROM contacts
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
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "SELECT * FROM contacts WHERE id = $1 AND workspace_id = $2"
      : "SELECT * FROM contacts WHERE id = $1",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rows[0] || null;
}

/**
 * Exact, case-insensitive email lookup. See the identical helper in leads.js
 * for why findAll({ q }) cannot be used and why the newest match wins. Pass
 * `workspaceId` for lookups driven by an anonymous form submission.
 */
export async function findByEmail(email, workspaceId) {
  const value = String(email || "").trim();
  if (!value) return null;
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "SELECT * FROM contacts WHERE LOWER(COALESCE(email, '')) = LOWER($1) AND workspace_id = $2 ORDER BY created_at DESC LIMIT 1"
      : "SELECT * FROM contacts WHERE LOWER(COALESCE(email, '')) = LOWER($1) ORDER BY created_at DESC LIMIT 1",
    scoped ? [value, workspaceId] : [value],
  );
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO contacts (
       workspace_id, company_id, first_name, last_name, email, phone,
       title, owner_id, custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      data.workspace_id,
      data.company_id,
      data.first_name,
      data.last_name,
      data.email,
      data.phone,
      data.title,
      data.owner_id,
      data.custom_fields ?? {},
    ],
  );
  return result.rows[0] || null;
}

export async function update(id, data = {}, workspaceId) {
  const statement = buildUpdateStatement({
    id,
    table: "contacts",
    allowedFields: UPDATE_FIELDS,
    data,
    workspaceId,
    jsonbFields: ["custom_fields"],
    jsonbFallback: {"custom_fields":"{}"},
  });
  if (!statement) return null;

  const result = await query(statement.sql, statement.values);
  return result.rows[0] || null;
}
async function remove(id, workspaceId) {
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "DELETE FROM contacts WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL)) RETURNING id"
      : "DELETE FROM contacts WHERE id = $1 RETURNING id",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rowCount > 0;
}

export { remove as delete };
