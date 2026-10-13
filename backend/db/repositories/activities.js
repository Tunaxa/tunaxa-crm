import { query } from "../pg.js";
import {
  cacheFlush,
  cacheGet,
  cacheSet,
  hashParams,
} from "../../services/cache.js";

const RESOURCE = "activities";

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

// The System type includes activities other than the four direct types.
export const DIRECT_TYPES = ["email", "call", "meeting", "note"];

function validatePositiveInteger(value, name) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }

  return number;
}

function getSort(sortBy) {
  const parts = typeof sortBy === "string" ? sortBy.split(":") : [];
  const direction = parts[1]?.toLowerCase();

  if (
    parts.length > 2 ||
    !SORT_COLUMNS.has(parts[0]) ||
    (parts.length === 2 &&
      direction !== "asc" &&
      direction !== "desc")
  ) {
    return {
      column: "created_at",
      direction: "DESC",
    };
  }

  return {
    column: parts[0],
    direction: direction === "asc" ? "ASC" : "DESC",
  };
}

function getSearchTerm(q) {
  if (q === undefined || q === null) {
    return "";
  }

  const value = String(q).trim();
  return value ? `%${value}%` : "";
}

// Search across the activity fields used by the timeline.
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

  const cacheKey = `${RESOURCE}:list:${hashParams({
    page: normalizedPage,
    limit: normalizedLimit,
    sortBy,
    q: searchTerm,
    type: typeFilter,
    contact: contactFilter,
    recordId: recordIdFilter,
  })}`;

  const cached = await cacheGet(cacheKey);

  if (cached !== null && cached !== undefined) {
    return cached;
  }

  const conditions = [];
  const params = [];

  if (searchTerm) {
    params.push(searchTerm);
    const placeholder = `$${params.length}`;
    conditions.push(`(${searchCondition(placeholder)})`);
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
      conditions.push(
        `LOWER(COALESCE(type, '')) = $${params.length}`,
      );
    }
  }

  // recordId and contact are alternatives, not an intersection.
  const recordConditions = [];

  if (recordIdFilter) {
    params.push(recordIdFilter);
    recordConditions.push(`record_id = $${params.length}`);
  }

  if (contactFilter) {
    params.push(contactFilter);
    const placeholder = `$${params.length}`;

    recordConditions.push(
      `LOWER(COALESCE(contact, '')) = ${placeholder}`,
      `LOWER(COALESCE(company, '')) = ${placeholder}`,
      `COALESCE(title, '') ILIKE '%' || ${placeholder} || '%'`,
    );
  }

  if (recordConditions.length > 0) {
    conditions.push(`(${recordConditions.join(" OR ")})`);
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  // Count matching activities on the server.
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM activities
     ${whereClause}`,
    [...params],
  );

  // Fetch only the requested page.
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

  const result = {
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
  const result = await query(
    "SELECT * FROM activities WHERE id = $1",
    [id],
  );

  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO activities (
       workspace_id,
       type,
       title,
       subject,
       description,
       contact,
       company,
       direction,
       record_id,
       entity_type,
       entity_id,
       user_id,
       contact_id,
       deal_id,
       metadata,
       custom_fields
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13, $14, $15, $16
     )
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

  await cacheFlush(`${RESOURCE}:list:*`);

  return result.rows[0] || null;
}

export async function update(id, data = {}) {
  const fields = UPDATE_FIELDS.filter(
    (field) =>
      Object.prototype.hasOwnProperty.call(data, field) &&
      data[field] !== undefined,
  );

  if (fields.length === 0) {
    return null;
  }

  const values = fields.map((field) => data[field]);

  const assignments = fields.map(
    (field, index) => `${field} = $${index + 1}`,
  );

  values.push(id);

  const result = await query(
    `UPDATE activities
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
    "DELETE FROM activities WHERE id = $1 RETURNING id",
    [id],
  );

  await cacheFlush(`${RESOURCE}:list:*`);

  return result.rowCount > 0;
}

export { remove as delete };