import { query } from "../pg.js";
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

export async function update(id, data = {}) {
  const fields = UPDATE_FIELDS.filter(
    (field) =>
      Object.prototype.hasOwnProperty.call(data, field) &&
      data[field] !== undefined,
  );
  if (fields.length === 0) return null;

  const values = [];
  const assignments = [];
  fields.forEach((field, index) => {
    let val = data[field];
    if (field === "steps") {
      val = toJsonb(val, "[]");
    } else if (field === "custom_fields") {
      val = toJsonb(val, "{}");
    } else if (field === "completed_at" && val) {
      val = new Date(val);
    }
    values.push(val);
    assignments.push(`${field} = $${index + 1}`);
  });
  values.push(id);

  const result = await query(
    `UPDATE workflow_runs
     SET ${assignments.join(", ")}
     WHERE id = $${values.length}
     RETURNING *`,
    values,
  );
  return result.rows[0] || null;
}

export async function findById(id) {
  const result = await query("SELECT * FROM workflow_runs WHERE id = $1", [id]);
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
