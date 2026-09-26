import { query } from "../pg.js";
import { toJsonb } from "./json.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "invoice_number",
  "status",
  "total",
  "due_date",
  "paid_at",
]);
const UPDATE_FIELDS = [
  "invoice_number",
  "order_id",
  "deal_id",
  "company_id",
  "contact_id",
  "status",
  "total",
  "due_date",
  "paid_at",
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
  order_id = "",
  deal_id = "",
  company_id = "",
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
    ["order_id", order_id],
    ["deal_id", deal_id],
    ["company_id", company_id],
  ];
  const conditions = [];
  const params = [];
  if (searchTerm) {
    params.push(searchTerm);
    const p = `$${params.length}`;
    conditions.push(`(invoice_number ILIKE ${p} OR status ILIKE ${p})`);
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
     FROM invoices
     ${whereClause}`,
    [...params],
  );
  const params2 = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT *
     FROM invoices
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

export async function findById(id) {
  const result = await query("SELECT * FROM invoices WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO invoices (
       workspace_id, invoice_number, order_id, deal_id, company_id, contact_id,
       status, total, due_date, paid_at, items, custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      data.workspace_id,
      data.invoice_number,
      data.order_id,
      data.deal_id,
      data.company_id,
      data.contact_id,
      data.status,
      data.total,
      data.due_date,
      data.paid_at,
      toJsonb(data.items, []),
      data.custom_fields ?? {},
    ],
  );
  return result.rows[0] || null;
}

export async function update(id, data = {}) {
  const fields = UPDATE_FIELDS.filter(
    (field) =>
      Object.prototype.hasOwnProperty.call(data, field) &&
      data[field] !== undefined,
  );
  if (fields.length === 0) return null;

  const values = fields.map((field) =>
    field === "items" ? toJsonb(data[field], []) : data[field],
  );
  const assignments = fields.map(
    (field, index) => `${field} = $${index + 1}`,
  );
  values.push(id);
  const result = await query(
    `UPDATE invoices
     SET ${assignments.join(", ")}
     WHERE id = $${fields.length + 1}
     RETURNING *`,
    values,
  );
  return result.rows[0] || null;
}

async function remove(id) {
  const result = await query(
    "DELETE FROM invoices WHERE id = $1 RETURNING id",
    [id],
  );
  return result.rowCount > 0;
}

/** Outstanding vs. paid totals for the finance summary. */
export async function getFinanceSummary() {
  const result = await query(
    `SELECT COALESCE(SUM(total), 0) AS issued,
            COALESCE(SUM(total) FILTER (WHERE LOWER(COALESCE(status, '')) = 'paid'), 0) AS paid,
            COALESCE(SUM(total) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('pending', 'overdue')), 0) AS outstanding
     FROM invoices`,
    [],
  );
  return result.rows[0] || null;
}

export { remove as delete };
