import { query } from "../pg.js";

import {
  cacheFlush,
  cacheGet,
  cacheSet,
  hashParams,
} from "../../services/cache.js";

const RESOURCE = "deals";
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

export async function findAll(params = {}) {
  const cacheKey = `${RESOURCE}:list:${hashParams(params)}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const {
    page = 1,
    limit = 20,
    sortBy = "created_at:desc",
    q = "",
  } = params;
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
    searchTerm ? [searchTerm] : [],
  );
  const limitParameter = searchTerm ? 2 : 1;
  const offsetParameter = searchTerm ? 3 : 2;
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
  await cacheSet(cacheKey, result, 60);
  return result;
}

export async function findById(id) {
  const result = await query("SELECT * FROM deals WHERE id = $1", [id]);
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
  await cacheFlush(`${RESOURCE}:list:*`);
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
    `UPDATE deals
     SET ${assignments.join(", ")}
     WHERE id = $${fields.length + 1}
     RETURNING *`,
    values,
  );
  await cacheFlush(`${RESOURCE}:list:*`);
  return result.rows[0] || null;
}

async function remove(id) {
  const result = await query(
    "DELETE FROM deals WHERE id = $1 RETURNING id",
    [id],
  );
  await cacheFlush(`${RESOURCE}:list:*`);
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
