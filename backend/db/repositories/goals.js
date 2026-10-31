import { query } from "../pg.js";
import { buildUpdateStatement } from "./update-builder.js";
import { toJsonb } from "./json.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "name",
  "type",
  "target",
  "period",
  "status",
  "start_date",
  "end_date",
]);

const UPDATE_FIELDS = [
  "name",
  "type",
  "target",
  "period",
  "assigned_to",
  "assigned_type",
  "start_date",
  "end_date",
  "status",
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
  limit = 50,
  sortBy = "created_at:desc",
  q = "",
  status = "",
  type = "",
  assignedTo = "",
  period = "",
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

  const statusFilter = String(status || "").trim().toLowerCase();
  const typeFilter = String(type || "").trim().toLowerCase();
  const assignedToFilter = String(assignedTo || "").trim();
  const periodFilter = String(period || "").trim().toLowerCase();

  const conditions = [];
  const params = [];

  if (workspaceId) {
    params.push(workspaceId);
    conditions.push(
      `(workspace_id = $${params.length} OR ($${params.length} = 'default' AND workspace_id IS NULL))`,
    );
  }

  if (searchTerm) {
    params.push(searchTerm);
    const p = `$${params.length}`;
    conditions.push(
      `(name ILIKE ${p} OR type ILIKE ${p} OR period ILIKE ${p} OR status ILIKE ${p})`,
    );
  }

  if (statusFilter) {
    params.push(statusFilter);
    conditions.push(`LOWER(COALESCE(status, '')) = $${params.length}`);
  }

  if (typeFilter) {
    params.push(typeFilter);
    conditions.push(`LOWER(COALESCE(type, '')) = $${params.length}`);
  }

  if (assignedToFilter) {
    params.push(assignedToFilter);
    conditions.push(`assigned_to = $${params.length}`);
  }

  if (periodFilter) {
    params.push(periodFilter);
    conditions.push(`LOWER(COALESCE(period, '')) = $${params.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM goals
     ${whereClause}`,
    [...params],
  );

  const params2 = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT *
     FROM goals
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
  let sql = "SELECT * FROM goals WHERE id = $1";
  const params = [id];
  if (workspaceId) {
    params.push(workspaceId);
    sql += ` AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL))`;
  }
  const result = await query(sql, params);
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const hasId = Boolean(data.id);
  const sql = hasId
    ? `INSERT INTO goals (
         id, workspace_id, name, type, target, period, assigned_to,
         assigned_type, start_date, end_date, status, custom_fields
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`
    : `INSERT INTO goals (
         workspace_id, name, type, target, period, assigned_to,
         assigned_type, start_date, end_date, status, custom_fields
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`;

  const params = hasId
    ? [
        data.id,
        data.workspace_id || "default",
        data.name || "Untitled Goal",
        data.type || "revenue",
        Number(data.target) || 0,
        data.period || "monthly",
        data.assigned_to || null,
        data.assigned_type || "user",
        data.start_date || null,
        data.end_date || null,
        data.status || "active",
        toJsonb(data.custom_fields, {}),
      ]
    : [
        data.workspace_id || "default",
        data.name || "Untitled Goal",
        data.type || "revenue",
        Number(data.target) || 0,
        data.period || "monthly",
        data.assigned_to || null,
        data.assigned_type || "user",
        data.start_date || null,
        data.end_date || null,
        data.status || "active",
        toJsonb(data.custom_fields, {}),
      ];

  const result = await query(sql, params);
  return result.rows[0] || null;
}

export async function update(id, data = {}, workspaceId) {
  const statement = buildUpdateStatement({
    id,
    table: "goals",
    allowedFields: UPDATE_FIELDS,
    data,
    workspaceId,
    jsonbFields: ["custom_fields"],
    jsonbFallback: {"custom_fields":"{}"},
  });
  // An update with nothing in it is a no-op, not a missing row: answer with
  // the record as it stands so the caller still gets its full state back.
  if (!statement) return findById(id, workspaceId);

  const result = await query(statement.sql, statement.values);
  return result.rows[0] || null;
}
async function remove(id, workspaceId) {
  let sql = "DELETE FROM goals WHERE id = $1";
  const params = [id];
  if (workspaceId) {
    params.push(workspaceId);
    sql += ` AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL))`;
  }
  sql += " RETURNING id";
  const result = await query(sql, params);
  return result.rowCount > 0;
}

export { remove as delete };
