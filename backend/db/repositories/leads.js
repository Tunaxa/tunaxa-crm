import { query } from "../pg.js";

const SORT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "first_name",
  "last_name",
  "email",
  "phone",
  "company_name",
  "status",
  "value",
]);
const UPDATE_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "company_name",
  "status",
  "source",
  "value",
  "owner_id",
  "custom_fields",
];

function enrichLead(row) {
  if (!row) return row;
  const cf =
    typeof row.custom_fields === "object" && row.custom_fields !== null
      ? row.custom_fields
      : typeof row.custom_fields === "string"
      ? JSON.parse(row.custom_fields || "{}")
      : {};
  if (row.score === undefined && cf.score !== undefined) {
    row.score = cf.score;
  }
  if (row.last_scored_at === undefined && cf.last_scored_at !== undefined) {
    row.last_scored_at = cf.last_scored_at;
  }
  return row;
}

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
  // Ordered condition list so the workspace predicate can be prepended without
  // renumbering the search placeholders by hand.
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
      `(first_name ILIKE ${p} OR last_name ILIKE ${p} OR email ILIKE ${p} OR phone ILIKE ${p} OR company_name ILIKE ${p})`,
    );
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM leads
     ${whereClause}`,
    [...params],
  );
  const params2 = [...params, normalizedLimit, offset];
  const dataResult = await query(
    `SELECT *
     FROM leads
     ${whereClause}
     ORDER BY ${column} ${direction}
     LIMIT $${params2.length - 1} OFFSET $${params2.length}`,
    params2,
  );
  const total = Number(countResult.rows[0]?.total ?? 0);
  return {
    data: dataResult.rows.map(enrichLead),
    total,
    page: normalizedPage,
    limit: normalizedLimit,
    totalPages: Math.ceil(total / normalizedLimit),
  };
}

/**
 * `workspaceId` is optional so the authenticated CRUD routes keep working
 * unchanged, but any lookup driven by an *anonymous* caller must pass it: a
 * public form submit supplies a bare `recordId`, and without the filter a
 * visitor who guessed a UUID from another tenant could have that lead
 * overwritten by their submission.
 */
export async function findById(id, workspaceId) {
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "SELECT * FROM leads WHERE id = $1 AND workspace_id = $2"
      : "SELECT * FROM leads WHERE id = $1",
    scoped ? [id, workspaceId] : [id],
  );
  return enrichLead(result.rows[0]) || null;
}

/**
 * Exact, case-insensitive email lookup.
 *
 * findAll({ q }) is not usable here: `q` is a substring ILIKE, so looking up
 * "a@b.co" would also match "xa@b.com" and let a form submission overwrite the
 * wrong person. routes/forms.js needs identity, not a search.
 *
 * The email index is not unique, so several leads can share an address.
 * ORDER BY created_at DESC reproduces the old behaviour of `.find()` over a
 * newest-first array: the most recent match wins.
 *
 * `workspaceId` scopes the match to one tenant. routes/forms.js passes the
 * submitting form's workspace so a form cannot update a same-email lead that
 * belongs to a different workspace.
 *
 * LOWER() on both sides means the plain btree index on email cannot be used for
 * this lookup. That is deliberate: storing addresses case-folded instead would
 * silently change what the equality means for existing rows.
 */
export async function findByEmail(email, workspaceId) {
  const value = String(email || "").trim();
  if (!value) return null;
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "SELECT * FROM leads WHERE LOWER(COALESCE(email, '')) = LOWER($1) AND workspace_id = $2 ORDER BY created_at DESC LIMIT 1"
      : "SELECT * FROM leads WHERE LOWER(COALESCE(email, '')) = LOWER($1) ORDER BY created_at DESC LIMIT 1",
    scoped ? [value, workspaceId] : [value],
  );
  return enrichLead(result.rows[0]) || null;
}

export async function create(data = {}) {
  const createData = { ...data };
  if (
    createData.score !== undefined ||
    createData.last_scored_at !== undefined ||
    createData.lead_score !== undefined ||
    createData.score_factors !== undefined
  ) {
    const existingCf =
      typeof createData.custom_fields === "object" && createData.custom_fields !== null
        ? createData.custom_fields
        : {};
    createData.custom_fields = {
      ...existingCf,
      ...(createData.score !== undefined ? { score: createData.score } : {}),
      ...(createData.lead_score !== undefined ? { lead_score: createData.lead_score } : {}),
      ...(createData.score_factors !== undefined ? { score_factors: createData.score_factors } : {}),
      ...(createData.last_scored_at !== undefined ? { last_scored_at: createData.last_scored_at } : {}),
    };
  }

  const result = await query(
    `INSERT INTO leads (
       workspace_id, first_name, last_name, email, phone, company_name,
       status, source, value, owner_id, custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      createData.workspace_id,
      createData.first_name,
      createData.last_name,
      createData.email,
      createData.phone,
      createData.company_name,
      createData.status,
      createData.source,
      createData.value,
      createData.owner_id,
      createData.custom_fields ?? {},
    ],
  );
  return enrichLead(result.rows[0]) || null;
}

export async function update(id, data = {}, workspaceId) {
  const updateData = { ...data };
  if (
    updateData.score !== undefined ||
    updateData.last_scored_at !== undefined ||
    updateData.lead_score !== undefined ||
    updateData.score_factors !== undefined
  ) {
    const existingCf =
      typeof updateData.custom_fields === "object" && updateData.custom_fields !== null
        ? updateData.custom_fields
        : {};
    updateData.custom_fields = {
      ...existingCf,
      ...(updateData.score !== undefined ? { score: updateData.score } : {}),
      ...(updateData.lead_score !== undefined ? { lead_score: updateData.lead_score } : {}),
      ...(updateData.score_factors !== undefined ? { score_factors: updateData.score_factors } : {}),
      ...(updateData.last_scored_at !== undefined ? { last_scored_at: updateData.last_scored_at } : {}),
    };
  }

  const fields = UPDATE_FIELDS.filter(
    (field) =>
      Object.prototype.hasOwnProperty.call(updateData, field) &&
      updateData[field] !== undefined,
  );
  if (fields.length === 0) return null;

  const values = fields.map((field) => updateData[field]);
  const assignments = fields.map(
    (field, index) => `${field} = $${index + 1}`,
  );
  const scoped = workspaceId !== undefined && workspaceId !== null;
  values.push(id);
  if (scoped) values.push(workspaceId);
  const result = await query(
    `UPDATE leads
     SET ${assignments.join(", ")}
     WHERE id = $${fields.length + 1}${scoped ? ` AND (workspace_id = $${fields.length + 2} OR ($${fields.length + 2} = 'default' AND workspace_id IS NULL))` : ''}
     RETURNING *`,
    values,
  );
  return enrichLead(result.rows[0]) || null;
}

async function remove(id, workspaceId) {
  const scoped = workspaceId !== undefined && workspaceId !== null;
  const result = await query(
    scoped
      ? "DELETE FROM leads WHERE id = $1 AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL)) RETURNING id"
      : "DELETE FROM leads WHERE id = $1 RETURNING id",
    scoped ? [id, workspaceId] : [id],
  );
  return result.rowCount > 0;
}

export { remove as delete };
