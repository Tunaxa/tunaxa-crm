import { query } from "../pg.js";
import { toJsonb } from "./json.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "name",
  "status",
  "channel",
  "budget",
  "start_date",
  "end_date",
]);
const UPDATE_FIELDS = [
  "name",
  "channel",
  "status",
  "description",
  "budget",
  "spend",
  "target",
  "reached",
  "leads",
  "start_date",
  "end_date",
  "metrics",
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
  channel = "",
} = {}) {
  const normalizedPage = validatePositiveInteger(page, "page");
  const normalizedLimit = Math.min(
    validatePositiveInteger(limit, "limit"),
    100,
  );
  const offset = (normalizedPage - 1) * normalizedLimit;
  const searchTerm = getSearchTerm(q);
  const { column, direction } = getSort(sortBy);
  // A status or channel is a single stored value, so match it exactly rather
  // than fuzzily the way `q` does.
  const statusFilter = String(status || "").trim().toLowerCase();
  const channelFilter = String(channel || "").trim().toLowerCase();
  const conditions = [];
  const params = [];
  if (searchTerm) {
    params.push(searchTerm);
    const p = `$${params.length}`;
    conditions.push(
      `(name ILIKE ${p} OR description ILIKE ${p} OR status ILIKE ${p} OR channel ILIKE ${p})`,
    );
  }
  if (statusFilter) {
    params.push(statusFilter);
    conditions.push(`LOWER(COALESCE(status, '')) = $${params.length}`);
  }
  if (channelFilter) {
    params.push(channelFilter);
    conditions.push(`LOWER(COALESCE(channel, '')) = $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM campaigns
     ${whereClause}`,
    [...params],
  );
  const params2 = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT *
     FROM campaigns
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
  const result = await query("SELECT * FROM campaigns WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO campaigns (
       workspace_id, name, channel, status, description, budget, spend,
       target, reached, leads, start_date, end_date, metrics, custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      data.workspace_id,
      data.name,
      data.channel,
      data.status,
      data.description,
      data.budget,
      data.spend,
      data.target,
      data.reached,
      data.leads,
      data.start_date,
      data.end_date,
      toJsonb(data.metrics, {}),
      toJsonb(data.custom_fields, {}),
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
    field === "metrics" || field === "custom_fields"
      ? toJsonb(data[field], null)
      : data[field],
  );
  const assignments = fields.map(
    (field, index) => `${field} = $${index + 1}`,
  );
  values.push(id);
  const result = await query(
    `UPDATE campaigns
     SET ${assignments.join(", ")}
     WHERE id = $${fields.length + 1}
     RETURNING *`,
    values,
  );
  return result.rows[0] || null;
}

async function remove(id) {
  const result = await query(
    "DELETE FROM campaigns WHERE id = $1 RETURNING id",
    [id],
  );
  return result.rowCount > 0;
}

export { remove as delete };
