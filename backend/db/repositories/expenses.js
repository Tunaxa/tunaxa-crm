import { query } from "../pg.js";
import { buildUpdateStatement } from "./update-builder.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "title",
  "category",
  "amount",
  "date",
  "vendor",
]);
const UPDATE_FIELDS = [
  "title",
  "category",
  "amount",
  "date",
  "vendor",
  "deal_id",
  "company_id",
  "user_id",
  "notes",
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
  category = "",
  deal_id = "",
  company_id = "",
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
    ["category", category],
    ["deal_id", deal_id],
    ["company_id", company_id],
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
      `(title ILIKE ${p} OR vendor ILIKE ${p} OR notes ILIKE ${p} OR category ILIKE ${p})`,
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
     FROM expenses
     ${whereClause}`,
    [...params],
  );
  const params2 = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT *
     FROM expenses
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
      ? "SELECT * FROM expenses WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL))"
      : "SELECT * FROM expenses WHERE id = $1",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO expenses (
       workspace_id, title, category, amount, date, vendor, deal_id, company_id,
       user_id, notes, custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      data.workspace_id,
      data.title,
      data.category,
      data.amount,
      data.date,
      data.vendor,
      data.deal_id,
      data.company_id,
      data.user_id,
      data.notes,
      data.custom_fields ?? {},
    ],
  );
  return result.rows[0] || null;
}

export async function update(id, data = {}, workspaceId) {
  const statement = buildUpdateStatement({
    id,
    table: "expenses",
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
      ? "DELETE FROM expenses WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL)) RETURNING id"
      : "DELETE FROM expenses WHERE id = $1 RETURNING id",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rowCount > 0;
}

/** Total spend for the finance summary, grouped by category. */
export async function getExpenseSummary() {
  const result = await query(
    `SELECT COALESCE(category, 'Uncategorized') AS category,
            COALESCE(SUM(amount), 0) AS total
     FROM expenses
     GROUP BY COALESCE(category, 'Uncategorized')
     ORDER BY total DESC`,
    [],
  );
  return result.rows;
}

export { remove as delete };
