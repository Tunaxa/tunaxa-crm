import { query } from "../pg.js";
import { toJsonb } from "./json.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "title",
  "quote_number",
  "status",
  "total",
  "expiration_date",
]);
const UPDATE_FIELDS = [
  "title",
  "quote_number",
  "deal_id",
  "company_id",
  "contact_id",
  "status",
  "subtotal",
  "discount",
  "tax",
  "total",
  "expiration_date",
  "items",
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
  status = "",
  deal_id = "",
  company_id = "",
  contact_id = "",
} = {}) {
  const normalizedPage = validatePositiveInteger(page, "page");
  const normalizedLimit = Math.min(
    validatePositiveInteger(limit, "limit"),
    100,
  );
  const offset = (normalizedPage - 1) * normalizedLimit;
  const searchTerm = getSearchTerm(q);
  const { column, direction } = getSort(sortBy);
  // `status` is a discrete stage label and the id filters are exact pointers, so
  // all three match exactly rather than fuzzily the way `q` does.
  const exactFilters = [
    ["status", status],
    ["deal_id", deal_id],
    ["company_id", company_id],
    ["contact_id", contact_id],
  ];
  const conditions = [];
  const params = [];
  if (searchTerm) {
    params.push(searchTerm);
    const p = `$${params.length}`;
    conditions.push(
      `(title ILIKE ${p} OR quote_number ILIKE ${p} OR status ILIKE ${p} OR notes ILIKE ${p})`,
    );
  }
  for (const [column_name, value] of exactFilters) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) continue;
    params.push(normalized);
    conditions.push(
      `LOWER(COALESCE(${column_name}, '')) = $${params.length}`,
    );
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM quotes
     ${whereClause}`,
    [...params],
  );
  const params2 = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT *
     FROM quotes
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
  const result = await query("SELECT * FROM quotes WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO quotes (
       workspace_id, title, quote_number, deal_id, company_id, contact_id,
       status, subtotal, discount, tax, total, expiration_date, items, notes,
       custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      data.workspace_id,
      data.title,
      data.quote_number,
      data.deal_id,
      data.company_id,
      data.contact_id,
      data.status,
      data.subtotal,
      data.discount,
      data.tax,
      data.total,
      data.expiration_date,
      toJsonb(data.items, []),
      data.notes,
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
    `UPDATE quotes
     SET ${assignments.join(", ")}
     WHERE id = $${fields.length + 1}
     RETURNING *`,
    values,
  );
  return result.rows[0] || null;
}

async function remove(id) {
  const result = await query("DELETE FROM quotes WHERE id = $1 RETURNING id", [
    id,
  ]);
  return result.rowCount > 0;
}

export { remove as delete };
