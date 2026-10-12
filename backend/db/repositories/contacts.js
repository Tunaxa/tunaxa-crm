import { query } from "../pg.js";
import { cachedList, invalidateListCache } from "./cache.js";

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

export function findAll(options = {}) {
  return cachedList("contacts", options, () => findAllUncached(options));
}

async function findAllUncached({
  page = 1,
  limit = 20,
  sortBy = "created_at:desc",
  q = "",
} = {}) {
  const normalizedPage = validatePositiveInteger(page, "page");
  const normalizedLimit = Math.min(
    validatePositiveInteger(limit, "limit"),
    100,
  );
  const offset = (normalizedPage - 1) * normalizedLimit;
  const searchTerm = getSearchTerm(q);
  const { column, direction } = getSort(sortBy);
  const whereClause = searchTerm
    ? "WHERE (first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR title ILIKE $1)"
    : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM contacts
     ${whereClause}`,
    searchTerm ? [searchTerm] : [],
  );
  const limitParameter = searchTerm ? 2 : 1;
  const offsetParameter = searchTerm ? 3 : 2;
  const dataResult = await query(
    `SELECT *
     FROM contacts
     ${whereClause}
     ORDER BY ${column} ${direction}
     LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
    searchTerm
      ? [searchTerm, normalizedLimit, offset]
      : [normalizedLimit, offset],
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
  const row = result.rows[0] || null;
  if (row) await invalidateListCache("contacts");
  return row;
}

export async function update(id, data = {}) {
  const fields = UPDATE_FIELDS.filter(
    (field) =>
      Object.prototype.hasOwnProperty.call(data, field) &&
      data[field] !== undefined,
  );
  if (fields.length === 0) return null;

  const values = fields.map((field) => data[field]);
  const assignments = fields.map(
    (field, index) => `${field} = $${index + 1}`,
  );
  values.push(id);
  const result = await query(
    `UPDATE contacts
     SET ${assignments.join(", ")}
     WHERE id = $${fields.length + 1}
     RETURNING *`,
    values,
  );
  const row = result.rows[0] || null;
  if (row) await invalidateListCache("contacts");
  return row;
}

async function remove(id) {
  const result = await query(
    "DELETE FROM contacts WHERE id = $1 RETURNING id",
    [id],
  );
  const deleted = result.rowCount > 0;
  if (deleted) await invalidateListCache("contacts");
  return deleted;
}

export { remove as delete };
