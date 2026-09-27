import { query } from "../pg.js";
import { toJsonb } from "./json.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "name",
  "entity",
  "last_sent_at",
]);

const UPDATE_FIELDS = [
  "name",
  "description",
  "entity",
  "query",
  "schedule",
  "schedule_enabled",
  "last_sent_at",
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
  entity = "",
  scheduledOnly = false,
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
  const entityFilter = String(entity || "").trim().toLowerCase();

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
    conditions.push(`(name ILIKE ${p} OR description ILIKE ${p} OR entity ILIKE ${p})`);
  }

  if (entityFilter) {
    params.push(entityFilter);
    conditions.push(`LOWER(COALESCE(entity, '')) = $${params.length}`);
  }

  if (scheduledOnly) {
    conditions.push("schedule_enabled = TRUE");
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM saved_reports
     ${whereClause}`,
    [...params],
  );

  const params2 = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT *
     FROM saved_reports
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
  let sql = "SELECT * FROM saved_reports WHERE id = $1";
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
    ? `INSERT INTO saved_reports (
         id, workspace_id, name, description, entity, query, schedule,
         schedule_enabled, last_sent_at, custom_fields
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`
    : `INSERT INTO saved_reports (
         workspace_id, name, description, entity, query, schedule,
         schedule_enabled, last_sent_at, custom_fields
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`;

  const columns = [
    data.workspace_id || "default",
    data.name || "Untitled Report",
    data.description || null,
    data.entity || null,
    toJsonb(data.query, {}),
    toJsonb(data.schedule, null),
    data.schedule_enabled === true,
    data.last_sent_at || null,
    toJsonb(data.custom_fields, {}),
  ];

  const params = hasId ? [data.id, ...columns] : columns;
  const result = await query(sql, params);
  return result.rows[0] || null;
}

export async function update(id, data = {}, workspaceId) {
  const fields = UPDATE_FIELDS.filter(
    (field) =>
      Object.prototype.hasOwnProperty.call(data, field) &&
      data[field] !== undefined,
  );
  if (fields.length === 0) return await findById(id, workspaceId);

  const values = fields.map((field) => {
    if (field === "query" || field === "schedule" || field === "custom_fields") {
      return toJsonb(data[field], field === "schedule" ? null : {});
    }
    if (field === "schedule_enabled") return data[field] === true;
    if (field === "last_sent_at") {
      return data[field] === "" ? null : data[field];
    }
    return data[field];
  });
  const assignments = fields.map(
    (field, index) => `${field} = $${index + 1}`,
  );
  values.push(id);

  let sql = `UPDATE saved_reports SET ${assignments.join(", ")} WHERE id = $${fields.length + 1}`;
  if (workspaceId) {
    values.push(workspaceId);
    sql += ` AND (workspace_id = $${fields.length + 2} OR ($${fields.length + 2} = 'default' AND workspace_id IS NULL))`;
  }
  sql += " RETURNING *";

  const result = await query(sql, values);
  return result.rows[0] || null;
}

async function remove(id, workspaceId) {
  let sql = "DELETE FROM saved_reports WHERE id = $1";
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
