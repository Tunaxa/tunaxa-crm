import { query } from "../pg.js";
import { buildUpdateStatement } from "./update-builder.js";
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

function blankTimestamp(value) {
  return value === "" ? null : value;
}

export async function findAll({
  page = 1,
  limit = 20,
  sortBy = "created_at:desc",
  q = "",
  stage = "",
  priority = "",
  source = "",
  workspaceId,
} = {}) {
  const normalizedPage = validatePositiveInteger(page, "page");
  const normalizedLimit = Math.min(validatePositiveInteger(limit, "limit"), 100);
  const offset = (normalizedPage - 1) * normalizedLimit;
  const searchTerm = getSearchTerm(q);
  const { column, direction } = getSort(sortBy);
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

export async function findById(id, workspaceId) {
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "SELECT * FROM tickets WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL))"
      : "SELECT * FROM tickets WHERE id = $1",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO tickets (
       workspace_id, subject, description, stage, priority, source, contact,
       contact_email, comments, first_response_at, resolved_at, resolved_by,
       status, custom_fields, first_response_due_at, sla_due_at, sla_breached,
       closed_at, stage_history
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
      blankTimestamp(data.first_response_at),
      blankTimestamp(data.resolved_at),
      data.resolved_by,
      data.status,
      toJsonb(data.custom_fields, {}),
      blankTimestamp(data.first_response_due_at),
      blankTimestamp(data.sla_due_at),
      data.sla_breached === undefined ? false : data.sla_breached,
      blankTimestamp(data.closed_at),
      toJsonb(data.stage_history, []),
    ],
  );
  return result.rows[0] || null;
}

export async function update(id, data = {}, workspaceId) {
  const statement = buildUpdateStatement({
    id,
    table: "tickets",
    allowedFields: UPDATE_FIELDS,
    data,
    workspaceId,
    jsonbFields: Array.from(JSONB_FIELDS),
    jsonbFallback: { custom_fields: "{}", comments: "[]", stage_history: "[]" },
    serialize: (field, value) => {
      if (TIMESTAMP_FIELDS.has(field)) return blankTimestamp(value);
      return value;
    },
  });
  if (!statement) return null;

  const result = await query(statement.sql, statement.values);
  return result.rows[0] || null;
}

export async function addComment(id, comment, workspaceId) {
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? `UPDATE tickets
         SET comments = $3::jsonb || COALESCE(comments, '[]'::jsonb),
             first_response_at = COALESCE(first_response_at, NOW())
         WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL))
         RETURNING *`
      : `UPDATE tickets
         SET comments = $2::jsonb || COALESCE(comments, '[]'::jsonb),
             first_response_at = COALESCE(first_response_at, NOW())
         WHERE id = $1
         RETURNING *`,
    scoped ? [id, workspaceId, toJsonb([comment], "[]")] : [id, toJsonb([comment], "[]")],
  );
  return result.rows[0] || null;
}

async function remove(id, workspaceId) {
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "DELETE FROM tickets WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL)) RETURNING id"
      : "DELETE FROM tickets WHERE id = $1 RETURNING id",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rowCount > 0;
}

export { remove as delete };