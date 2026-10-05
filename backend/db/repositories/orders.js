import { query } from "../pg.js";
import { buildUpdateStatement } from "./update-builder.js";
import { toJsonb } from "./json.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "order_number",
  "status",
  "total",
]);
const UPDATE_FIELDS = [
  "order_number",
  "deal_id",
  "company_id",
  "contact_id",
  "quote_id",
  "contract_id",
  "status",
  "total",
  "items",
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
  status = "",
  deal_id = "",
  quote_id = "",
  contract_id = "",
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
  const exactFilters = [
    ["status", status],
    ["deal_id", deal_id],
    ["quote_id", quote_id],
    ["contract_id", contract_id],
  ];
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
      `(order_number ILIKE ${p} OR status ILIKE ${p})`,
    );
  }
  for (const [column_name, value] of exactFilters) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) continue;
    params.push(normalized);
    conditions.push(`LOWER(COALESCE(${column_name}, '')) = $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM orders
     ${whereClause}`,
    [...params],
  );
  const params2 = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT *
     FROM orders
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
      ? "SELECT * FROM orders WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL))"
      : "SELECT * FROM orders WHERE id = $1",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO orders (
       workspace_id, order_number, deal_id, company_id, contact_id, quote_id,
       contract_id, status, total, items, custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      data.workspace_id,
      data.order_number,
      data.deal_id,
      data.company_id,
      data.contact_id,
      data.quote_id,
      data.contract_id,
      data.status,
      data.total,
      toJsonb(data.items, []),
      data.custom_fields ?? {},
    ],
  );
  return result.rows[0] || null;
}

export async function update(id, data = {}, workspaceId) {
  const statement = buildUpdateStatement({
    id,
    table: "orders",
    allowedFields: UPDATE_FIELDS,
    data,
    workspaceId,
    jsonbFields: ["custom_fields", "items"],
    jsonbFallback: {"custom_fields":"{}", "items":"[]"},
  });
  if (!statement) return null;

  const result = await query(statement.sql, statement.values);
  return result.rows[0] || null;
}
async function remove(id, workspaceId) {
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "DELETE FROM orders WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL)) RETURNING id"
      : "DELETE FROM orders WHERE id = $1 RETURNING id",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rowCount > 0;
}

export { remove as delete };
