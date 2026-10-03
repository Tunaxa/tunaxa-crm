import { query } from "../pg.js";
import { buildUpdateStatement } from "./update-builder.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "name",
  "domain",
  "industry",
  "size",
  "employees",
]);
const UPDATE_FIELDS = [
  "name",
  "domain",
  "industry",
  "website",
  "country",
  "size",
  "employees",
  "owner",
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
  // Built as an ordered condition list rather than a fixed `$1` string so the
  // workspace predicate can be appended without renumbering by hand.
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
      `(name ILIKE ${p} OR domain ILIKE ${p} OR industry ILIKE ${p} OR website ILIKE ${p} OR country ILIKE ${p})`,
    );
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM companies
     ${whereClause}`,
    [...params],
  );
  const params2 = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT *
     FROM companies
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
      ? "SELECT * FROM companies WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL))"
      : "SELECT * FROM companies WHERE id = $1",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO companies (
       workspace_id, name, domain, industry, website, country, size,
       employees, owner, custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      data.workspace_id,
      data.name,
      data.domain,
      data.industry,
      data.website,
      data.country,
      data.size,
      data.employees,
      data.owner,
      data.custom_fields ?? {},
    ],
  );
  return result.rows[0] || null;
}

export async function update(id, data = {}, workspaceId) {
  const statement = buildUpdateStatement({
    id,
    table: "companies",
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
      ? "DELETE FROM companies WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL)) RETURNING id"
      : "DELETE FROM companies WHERE id = $1 RETURNING id",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rowCount > 0;
}

export { remove as delete };
