import { query } from "../pg.js";
import { buildUpdateStatement } from "./update-builder.js";
import { toJsonb } from "./json.js";

const UPDATE_FIELDS = [
  "status",
  "completed_at",
  "steps",
  "error_message",
  "custom_fields",
];

function validatePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO workflow_runs (
       workspace_id, workflow_id, trigger_event, status,
       started_at, completed_at, steps, error_message, custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      data.workspace_id ?? "default",
      data.workflow_id,
      data.trigger_event,
      data.status ?? "running",
      data.started_at ? new Date(data.started_at) : new Date(),
      data.completed_at ? new Date(data.completed_at) : null,
      toJsonb(data.steps, "[]"),
      data.error_message ?? null,
      toJsonb(data.custom_fields, "{}"),
    ],
  );
  return result.rows[0] || null;
}

export async function update(id, data = {}, workspaceId) {
  const statement = buildUpdateStatement({
    id,
    table: "workflow_runs",
    allowedFields: UPDATE_FIELDS,
    data,
    workspaceId,
    jsonbFields: ["custom_fields", "steps"],
    jsonbFallback: {"custom_fields":"{}", "steps":"[]"},
    serialize: (field, value) =>
      field === "completed_at" && value ? new Date(value) : value,
  });
  if (!statement) return null;

  const result = await query(statement.sql, statement.values);
  return result.rows[0] || null;
}
export async function findById(id, workspaceId) {
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "SELECT * FROM workflow_runs WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL))"
      : "SELECT * FROM workflow_runs WHERE id = $1",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rows[0] || null;
}

export async function findByWorkflowId(
  workflowId,
  { page = 1, limit = 50, workspaceId } = {},
) {
  const normalizedPage = validatePositiveInteger(page, "page");
  const normalizedLimit = Math.min(
    validatePositiveInteger(limit, "limit"),
    100,
  );
  const offset = (normalizedPage - 1) * normalizedLimit;

  let whereSql = "WHERE workflow_id = $1";
  const params = [workflowId];

  if (workspaceId !== undefined && workspaceId !== null) {
    params.push(workspaceId);
    whereSql += ` AND workspace_id = $${params.length}`;
  }

  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM workflow_runs ${whereSql}`,
    params,
  );
  const total = Number(countResult.rows[0]?.total ?? 0);

  const dataParams = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT * FROM workflow_runs ${whereSql} ORDER BY started_at DESC, created_at DESC LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams,
  );

  return {
    data: dataResult.rows,
    total,
    page: normalizedPage,
    limit: normalizedLimit,
    totalPages: Math.ceil(total / normalizedLimit),
  };
}

export async function findAll({
  page = 1,
  limit = 50,
  workspaceId,
} = {}) {
  const normalizedPage = validatePositiveInteger(page, "page");
  const normalizedLimit = Math.min(
    validatePositiveInteger(limit, "limit"),
    100,
  );
  const offset = (normalizedPage - 1) * normalizedLimit;

  let whereSql = "";
  const params = [];

  if (workspaceId !== undefined && workspaceId !== null) {
    params.push(workspaceId);
    whereSql = `WHERE workspace_id = $1`;
  }

  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM workflow_runs ${whereSql}`,
    params,
  );
  const total = Number(countResult.rows[0]?.total ?? 0);

  const dataParams = [...params, normalizedLimit, offset];
  const limitIndex = dataParams.length - 1;
  const offsetIndex = dataParams.length;
  const dataResult = await query(
    `SELECT * FROM workflow_runs ${whereSql} ORDER BY started_at DESC, created_at DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    dataParams,
  );

  return {
    data: dataResult.rows,
    total,
    page: normalizedPage,
    limit: normalizedLimit,
    totalPages: Math.ceil(total / normalizedLimit),
  };
}
