import { query } from "../pg.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "first_name",
  "last_name",
  "email",
  "phone",
  "company_name",
  "status",
  "value",
]);
const UPDATE_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "company_name",
  "status",
  "source",
  "value",
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
    ? "WHERE (first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR company_name ILIKE $1)"
    : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM leads
     ${whereClause}`,
    searchTerm ? [searchTerm] : [],
  );
  const limitParameter = searchTerm ? 2 : 1;
  const offsetParameter = searchTerm ? 3 : 2;
  const dataResult = await query(
    `SELECT *
     FROM leads
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

/**
 * `workspaceId` is optional so the authenticated CRUD routes keep working
 * unchanged, but any lookup driven by an *anonymous* caller must pass it: a
 * public form submit supplies a bare `recordId`, and without the filter a
 * visitor who guessed a UUID from another tenant could have that lead
 * overwritten by their submission.
 */
export async function findById(id, workspaceId) {
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "SELECT * FROM leads WHERE id = $1 AND workspace_id = $2"
      : "SELECT * FROM leads WHERE id = $1",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rows[0] || null;
}

/**
 * Exact, case-insensitive email lookup.
 *
 * findAll({ q }) is not usable here: `q` is a substring ILIKE, so looking up
 * "a@b.co" would also match "xa@b.com" and let a form submission overwrite the
 * wrong person. routes/forms.js needs identity, not a search.
 *
 * The email index is not unique, so several leads can share an address.
 * ORDER BY created_at DESC reproduces the old behaviour of `.find()` over a
 * newest-first array: the most recent match wins.
 *
 * `workspaceId` scopes the match to one tenant. routes/forms.js passes the
 * submitting form's workspace so a form cannot update a same-email lead that
 * belongs to a different workspace.
 *
 * LOWER() on both sides means the plain btree index on email cannot be used for
 * this lookup. That is deliberate: storing addresses case-folded instead would
 * silently change what the equality means for existing rows.
 */
export async function findByEmail(email, workspaceId) {
  const value = String(email || "").trim();
  if (!value) return null;
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "SELECT * FROM leads WHERE LOWER(COALESCE(email, '')) = LOWER($1) AND workspace_id = $2 ORDER BY created_at DESC LIMIT 1"
      : "SELECT * FROM leads WHERE LOWER(COALESCE(email, '')) = LOWER($1) ORDER BY created_at DESC LIMIT 1",
    scoped ? [value, workspaceId] : [value],
  );
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO leads (
       workspace_id, first_name, last_name, email, phone, company_name,
       status, source, value, owner_id, custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      data.workspace_id,
      data.first_name,
      data.last_name,
      data.email,
      data.phone,
      data.company_name,
      data.status,
      data.source,
      data.value,
      data.owner_id,
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

  const values = fields.map((field) => data[field]);
  const assignments = fields.map(
    (field, index) => `${field} = $${index + 1}`,
  );
  values.push(id);
  const result = await query(
    `UPDATE leads
     SET ${assignments.join(", ")}
     WHERE id = $${fields.length + 1}
     RETURNING *`,
    values,
  );
  return result.rows[0] || null;
}

async function remove(id) {
  const result = await query(
    "DELETE FROM leads WHERE id = $1 RETURNING id",
    [id],
  );
  return result.rowCount > 0;
}

export { remove as delete };
