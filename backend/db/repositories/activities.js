import { query } from "../pg.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "type",
  "title",
  "subject",
  "direction",
]);
const UPDATE_FIELDS = [
  "type",
  "title",
  "subject",
  "description",
  "contact",
  "company",
  "direction",
  "record_id",
  "entity_type",
  "entity_id",
  "user_id",
  "contact_id",
  "deal_id",
  "metadata",
  "custom_fields",
];

// ?type=System is a bucket, not a stored value: it means "anything that is not
// one of the four interaction types the timeline renders as its own tab.
export const DIRECT_TYPES = ["email", "call", "meeting", "note"];

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

// Free-text search mirrors the legacy JSON path, which matched the whole
// serialized record. Every column it can reach is listed here.
function searchCondition(param) {
  return [
    "title",
    "subject",
    "description",
    "contact",
    "company",
    "type",
    "direction",
  ]
    .map((column) => `${column} ILIKE ${param}`)
    .join(" OR ");
}

export async function findAll({
  page = 1,
  limit = 20,
  sortBy = "created_at:desc",
  q = "",
  type = "",
  contact = "",
  recordId = "",
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
  const typeFilter = String(type || "").trim().toLowerCase();
  const recordIdFilter = String(recordId || "").trim();
  const contactFilter = String(contact || "").trim().toLowerCase();
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
    conditions.push(`(${searchCondition(p)})`);
  }

  if (typeFilter) {
    if (typeFilter === "system") {
      conditions.push(
        `LOWER(COALESCE(type, '')) NOT IN (${DIRECT_TYPES.map(
          (value) => `'${value}'`,
        ).join(", ")})`,
      );
    } else {
      params.push(typeFilter);
      conditions.push(`LOWER(COALESCE(type, '')) = $${params.length}`);
    }
  }

  // `recordId` and `contact` are alternatives, not an intersection: the legacy
  // filter kept a row when either one matched, and the timeline relies on that
  // to show a record's events when only its name is known.
  const recordConditions = [];
  if (recordIdFilter) {
    params.push(recordIdFilter);
    recordConditions.push(`record_id = $${params.length}`);
  }
  if (contactFilter) {
    params.push(contactFilter);
    const p = `$${params.length}`;
    recordConditions.push(
      `LOWER(COALESCE(contact, '')) = ${p}`,
      `LOWER(COALESCE(company, '')) = ${p}`,
      `COALESCE(title, '') ILIKE '%' || ${p} || '%'`,
    );
  }
  if (recordConditions.length) {
    conditions.push(`(${recordConditions.join(" OR ")})`);
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM activities
     ${whereClause}`,
    [...params],
  );
  const dataParams = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT *
     FROM activities
     ${whereClause}
     ORDER BY ${column} ${direction}
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams,
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
      ? "SELECT * FROM activities WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL))"
      : "SELECT * FROM activities WHERE id = $1",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO activities (
       workspace_id, type, title, subject, description, contact, company,
       direction, record_id, entity_type, entity_id, user_id, contact_id,
       deal_id, metadata, custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
    [
      data.workspace_id,
      data.type,
      data.title,
      data.subject,
      data.description,
      data.contact,
      data.company,
      data.direction,
      data.record_id,
      data.entity_type,
      data.entity_id,
      data.user_id,
      data.contact_id,
      data.deal_id,
      data.metadata ?? {},
      data.custom_fields ?? {},
    ],
  );
  return result.rows[0] || null;
}

export async function update(id, data = {}, workspaceId) {
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
  const scoped = workspaceId !== undefined && workspaceId !== null;
  values.push(id);
  if (scoped) values.push(workspaceId);
  const result = await query(
    `UPDATE activities
     SET ${assignments.join(", ")}
     WHERE id = $${fields.length + 1}${scoped ? ` AND (workspace_id = $${fields.length + 2} OR ($${fields.length + 2} = 'default' AND workspace_id IS NULL))` : ''}
     RETURNING *`,
    values,
  );
  return result.rows[0] || null;
}

async function remove(id, workspaceId) {
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "DELETE FROM activities WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL)) RETURNING id"
      : "DELETE FROM activities WHERE id = $1 RETURNING id",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rowCount > 0;
}

export { remove as delete };
