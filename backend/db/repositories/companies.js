import { query } from "../pg.js";

import {
  cacheFlush,
  cacheGet,
  cacheSet,
  hashParams,
} from "../../services/cache.js";

const RESOURCE = "companies";
const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "name",
  "domain",
  "industry",
  "size",
  "employees",
]);
const UPDATE_FIELDS = [
  "name",
  "domain",
  "industry",
  "website",
  "country",
  "size",
  "employees",
  "owner",
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
  const whereClause = searchTerm
    ? "WHERE (name ILIKE $1 OR domain ILIKE $1 OR industry ILIKE $1 OR website ILIKE $1 OR country ILIKE $1)"
    : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM companies
     ${whereClause}`,
    searchTerm ? [searchTerm] : [],
  );
  const limitParameter = searchTerm ? 2 : 1;
  const offsetParameter = searchTerm ? 3 : 2;
  const dataResult = await query(
    `SELECT *
     FROM companies
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
  await cacheSet(cacheKey, result, 60);
  return result;
}

export async function findById(id) {
  const result = await query("SELECT * FROM companies WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO companies (
       workspace_id, name, domain, industry, website, country, size,
       employees, owner, custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      data.workspace_id,
      data.name,
      data.domain,
      data.industry,
      data.website,
      data.country,
      data.size,
      data.employees,
      data.owner,
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
    `UPDATE companies
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
    "DELETE FROM companies WHERE id = $1 RETURNING id",
    [id],
  );
  await cacheFlush(`${RESOURCE}:list:*`);
  return result.rowCount > 0;
}

export { remove as delete };
