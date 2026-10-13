import { query } from "../pg.js";
import {
  cacheFlush,
  cacheGet,
  cacheSet,
  hashParams,
} from "../../services/cache.js";

const RESOURCE = "tasks";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "title",
  "status",
  "due_date",
  "priority",
]);

const UPDATE_FIELDS = [
  "title",
  "description",
  "status",
  "completed",
  "priority",
  "owner",
  "assigned_to",
  "due_date",
  "source",
  "contact_id",
  "deal_id",
  "custom_fields",
];

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

function normalizeCompleted(value) {
  if (value === true || value === false) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true") {
      return true;
    }

    if (normalized === "false") {
      return false;
    }
  }

  return undefined;
}

export async function findAll(options = {}) {
  const {
    page = 1,
    limit = 20,
    sortBy = "created_at:desc",
    q = "",
    status = "",
    completed,
  } = options;

  const normalizedPage = validatePositiveInteger(page, "page");

  const normalizedLimit = Math.min(
    validatePositiveInteger(limit, "limit"),
    100,
  );

  const offset = (normalizedPage - 1) * normalizedLimit;
  const searchTerm = getSearchTerm(q);
  const { column, direction } = getSort(sortBy);
  const statusFilter = String(status ?? "").trim().toLowerCase();
  const completedFilter = normalizeCompleted(completed);

  const cacheKey = `${RESOURCE}:list:${hashParams({
    page: normalizedPage,
    limit: normalizedLimit,
    sortBy,
    q: searchTerm,
    status: statusFilter,
    completed: completedFilter,
  })}`;

  const cached = await cacheGet(cacheKey);

  if (cached !== null && cached !== undefined) {
    return cached;
  }

  const conditions = [];
  const queryParams = [];

  if (searchTerm) {
    queryParams.push(searchTerm);
    const placeholder = `$${queryParams.length}`;

    conditions.push(
      `(title ILIKE ${placeholder}
        OR description ILIKE ${placeholder}
        OR status ILIKE ${placeholder}
        OR owner ILIKE ${placeholder})`,
    );
  }

  if (statusFilter) {
    queryParams.push(statusFilter);

    conditions.push(
      `LOWER(COALESCE(status, '')) = $${queryParams.length}`,
    );
  }

  if (completedFilter !== undefined) {
    queryParams.push(completedFilter);
    conditions.push(`completed = $${queryParams.length}`);
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  // Count matching tasks on the server.
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM tasks
     ${whereClause}`,
    queryParams,
  );

  // Fetch only the requested page.
  const dataParams = [
    ...queryParams,
    normalizedLimit,
    offset,
  ];

  const limitParameter = queryParams.length + 1;
  const offsetParameter = queryParams.length + 2;

  const dataResult = await query(
    `SELECT *
     FROM tasks
     ${whereClause}
     ORDER BY ${column} ${direction}
     LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
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
    "SELECT * FROM tasks WHERE id = $1",
    [id],
  );

  return result.rows[0] || null;
}

export async function create(data = {}) {
  const result = await query(
    `INSERT INTO tasks (
       workspace_id,
       title,
       description,
       status,
       completed,
       priority,
       owner,
       assigned_to,
       due_date,
       source,
       contact_id,
       deal_id,
       custom_fields
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13
     )
     RETURNING *`,
    [
      data.workspace_id,
      data.title,
      data.description,
      data.status,
      data.completed ?? false,
      data.priority,
      data.owner,
      data.assigned_to,
      data.due_date,
      data.source,
      data.contact_id,
      data.deal_id,
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
    `UPDATE tasks
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
    "DELETE FROM tasks WHERE id = $1 RETURNING id",
    [id],
  );

  await cacheFlush(`${RESOURCE}:list:*`);

  return result.rowCount > 0;
}

export { remove as delete };