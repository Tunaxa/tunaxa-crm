import { query } from "../pg.js";
import { toJsonb } from "./json.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "subject",
  "stage",
  "priority",
  "source",
  "first_response_due_at",
  "sla_due_at",
  "sla_breached",
  "resolved_at",
  "closed_at",
]);
const UPDATE_FIELDS = [
  "subject",
  "description",
  "stage",
  "priority",
  "source",
  "contact",
  "contact_email",
  "comments",
  "first_response_at",
  "first_response_due_at",
  "resolved_at",
  "resolved_by",
  "sla_due_at",
  "sla_breached",
  "closed_at",
  "stage_history",
  "status",
  "custom_fields",
];
// timestamptz columns that reject the empty string a legacy client may send to
// mean "not set". Normalize it to null in both create() and update().
const TIMESTAMP_FIELDS = new Set([
  "first_response_at",
  "first_response_due_at",
  "resolved_at",
  "sla_due_at",
  "closed_at",
]);
const JSONB_FIELDS = new Set(["comments", "stage_history", "custom_fields"]);

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
  stage = "",
  priority = "",
  source = "",
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
  if (searchTerm) {
    params.push(searchTerm);
    const p = `$${params.length}`;
    conditions.push(
      `(subject ILIKE ${p} OR description ILIKE ${p} OR contact ILIKE ${p} OR contact_email ILIKE ${p})`,
    );
  }
  for (const [column_, value] of [
    ["stage", stage],
    ["priority", priority],
    ["source", source],
  ]) {
    const filter = String(value || "").trim().toLowerCase();
    if (filter) {
      params.push(filter);
      conditions.push(`LOWER(COALESCE(${column_}, '')) = $${params.length}`);
    }
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM tickets
     ${whereClause}`,
    [...params],
  );
  const params2 = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT *
     FROM tickets
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
  const result = await query("SELECT * FROM tickets WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const blank = (value) => (value === "" ? null : value);
  const result = await query(
    `INSERT INTO tickets (
       workspace_id, subject, description, stage, priority, source, contact,
       contact_email, comments, first_response_at, resolved_at, resolved_by,
       status, custom_fields,
       first_response_due_at, sla_due_at, sla_breached, closed_at, stage_history
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17, $18, $19)
     RETURNING *`,
    [
      data.workspace_id,
      data.subject,
      data.description,
      data.stage,
      data.priority,
      data.source,
      data.contact,
      data.contact_email,
      toJsonb(data.comments, []),
      // The legacy handler seeded these with empty strings, which a
      // timestamptz column rejects. Normalize them to null so the column
      // stays genuinely "not yet responded/resolved".
      blank(data.first_response_at),
      blank(data.resolved_at),
      data.resolved_by,
      data.status,
      toJsonb(data.custom_fields, {}),
      // Added with P2-BE2-02; appended after the historical columns so the
      // parameter positions the repository tests pin stay stable.
      blank(data.first_response_due_at),
      blank(data.sla_due_at),
      data.sla_breached === undefined ? false : data.sla_breached,
      blank(data.closed_at),
      toJsonb(data.stage_history, []),
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

  const values = fields.map((field) => {
    if (JSONB_FIELDS.has(field)) return toJsonb(data[field], null);
    // A client that sends "" means "no timestamp", not the year zero.
    if (TIMESTAMP_FIELDS.has(field) && data[field] === "") {
      return null;
    }
    return data[field];
  });
  const assignments = fields.map(
    (field, index) => `${field} = $${index + 1}`,
  );
  values.push(id);
  const result = await query(
    `UPDATE tickets
     SET ${assignments.join(", ")}
     WHERE id = $${fields.length + 1}
     RETURNING *`,
    values,
  );
  return result.rows[0] || null;
}

/**
 * Append a comment, newest first, in a single statement.
 *
 * The legacy handler read the row, unshifted onto the JS array, and wrote the
 * whole thing back. Two concurrent comments would lose one of them, so the
 * concatenation happens server side. The new element goes on the LEFT of `||`
 * because jsonb array concatenation appends on the right, and the legacy
 * ordering is newest-first.
 */
export async function addComment(id, comment) {
  const result = await query(
    `UPDATE tickets
     SET comments = $2::jsonb || COALESCE(comments, '[]'::jsonb),
         first_response_at = COALESCE(first_response_at, NOW())
     WHERE id = $1
     RETURNING *`,
    [id, toJsonb([comment], "[]")],
  );
  return result.rows[0] || null;
}

async function remove(id) {
  const result = await query(
    "DELETE FROM tickets WHERE id = $1 RETURNING id",
    [id],
  );
  return result.rowCount > 0;
}

export { remove as delete };
