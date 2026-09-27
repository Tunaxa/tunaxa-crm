import { query } from "../pg.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "title",
  "value",
  "stage",
  "company",
  "expected_close_date",
]);
const UPDATE_FIELDS = [
  "title",
  "company",
  "company_id",
  "contact",
  "contact_id",
  "pipeline_id",
  "owner",
  "owner_id",
  "value",
  "stage",
  "expected_close_date",
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
  stage = "",
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
  // The pipeline board groups on an exact stage label, so match it exactly
  // rather than fuzzily the way `q` does.
  const stageFilter = String(stage || "").trim().toLowerCase();
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
      `(title ILIKE ${p} OR company ILIKE ${p} OR stage ILIKE ${p})`,
    );
  }
  if (stageFilter) {
    params.push(stageFilter);
    conditions.push(`LOWER(COALESCE(stage, '')) = $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM deals
     ${whereClause}`,
    [...params],
  );
  const params2 = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT *
     FROM deals
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
  // The workspace predicate lives in the WHERE clause, not in a post-filter: a
  // record belonging to another tenant has to be indistinguishable from one
  // that does not exist.
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "SELECT * FROM deals WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL))"
      : "SELECT * FROM deals WHERE id = $1",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO deals (
       workspace_id, title, company, company_id, contact, contact_id,
       pipeline_id, owner, owner_id, value, stage, expected_close_date,
       custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      data.workspace_id,
      data.title,
      data.company,
      data.company_id,
      data.contact,
      data.contact_id,
      data.pipeline_id,
      data.owner,
      data.owner_id,
      data.value,
      data.stage,
      data.expected_close_date,
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
    `UPDATE deals
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
      ? "DELETE FROM deals WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL)) RETURNING id"
      : "DELETE FROM deals WHERE id = $1 RETURNING id",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rowCount > 0;
}

export async function getPipelineSummary({ workspace_id } = {}) {
  const params = [];
  const whereClause =
    workspace_id === undefined || workspace_id === null
      ? ""
      : "WHERE workspace_id = $1";
  if (whereClause) params.push(workspace_id);
  const result = await query(
    `SELECT stage,
            COUNT(*)::int AS count,
            COALESCE(SUM(value), 0) AS total_value
     FROM deals
     ${whereClause}
     GROUP BY stage
     ORDER BY stage`,
    params,
  );
  return result.rows;
}

export { remove as delete };
