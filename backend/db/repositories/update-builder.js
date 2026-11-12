import { toJsonb } from "./json.js";

/**
 * Columns a client may never move through an update, whatever it puts in the
 * body.
 *
 * `id` is the primary key, `workspace_id` is the tenant boundary, and
 * `created_at` is the audit anchor. Every repository's UPDATE_FIELDS allowlist
 * already omits them, so this list is the second lock on the same door: a
 * future allowlist that accidentally grows a `workspace_id` entry would move a
 * record between tenants, and this check turns that into a silently dropped
 * key rather than a cross-tenant write.
 */
export const IMMUTABLE_COLUMNS = new Set([
  "id",
  "workspace_id",
  "created_at",
]);

/**
 * jsonb columns whose value is merged into what is already stored rather than
 * overwriting it.
 *
 * `custom_fields` is the overflow bag for every table that has one: the legacy
 * API is a flat record, so pgToLegacy() flattens the bag back to the top level
 * on read. Replacing the whole bag on a partial write is therefore destructive
 * in a way that is invisible in the response - a client that PATCHes one custom
 * field silently drops every other one. jsonb `||` gives key-level merge
 * semantics, which is what "partial update" has to mean for a bag.
 */
const DEFAULT_MERGE_FIELDS = ["custom_fields"];

/**
 * Reduce a client payload to the subset of columns this table may update.
 *
 * `undefined` is dropped rather than bound, because a JSON body cannot
 * distinguish "absent" from "null" the way a form encoder can, and binding
 * `undefined` to a column would null it out. An explicit `null` in the body is
 * kept: that is how a client clears a field.
 */
export function pickUpdateFields(allowedFields, data = {}) {
  return allowedFields.filter(
    (field) =>
      !IMMUTABLE_COLUMNS.has(field) &&
      Object.prototype.hasOwnProperty.call(data, field) &&
      data[field] !== undefined,
  );
}

/**
 * Build a strict partial UPDATE for one row.
 *
 * The SET clause is assembled from the keys the caller actually sent and
 * nothing else, so a column the payload does not mention is never written and
 * keeps its stored value. There is no code path that produces a full-row
 * replacement from a partial payload.
 *
 * `updated_at = NOW()` is appended unconditionally: it is a literal, not a
 * placeholder, so it cannot collide with the caller's parameters and it still
 * restamps a row that only had `custom_fields` touched. Tables deliberately
 * excluded from this stamp (a form's public submission counter) use their own
 * statement and do not come through here.
 *
 * Returns `null` when the payload carries no updatable column, so the caller
 * can tell "nothing to do" apart from "no such row" - the two need different
 * responses.
 *
 * @param {object}          options
 * @param {string}          options.id               Row to update.
 * @param {string}          options.table            Table to update.
 * @param {string[]}        options.allowedFields   Columns this resource may write.
 * @param {object}          [options.data]          Client payload.
 * @param {string}          [options.workspaceId]   Tenant to scope the row to.
 * @param {string[]}        [options.jsonbFields]   Columns to serialize as jsonb.
 * @param {object}          [options.jsonbFallback] Per-column fallback for the
 *                                                    serializer, keyed by column.
 * @param {string[]}        [options.mergeFields]   Columns merged instead of
 *                                                    replaced.
 * @param {(field: string, value: *) => *} [options.serialize]
 *                                                    Last-mile value coercion.
 * @returns {{sql: string, values: *, fields: string[]}|null}
 */
export function buildUpdateStatement({
  id,
  table,
  allowedFields,
  data = {},
  workspaceId,
  jsonbFields = [],
  jsonbFallback = {},
  mergeFields = DEFAULT_MERGE_FIELDS,
  serialize,
}) {
  const fields = pickUpdateFields(allowedFields, data);
  if (fields.length === 0) return null;

  const values = [];
  const assignments = fields.map((field) => {
    let value = data[field];
    if (jsonbFields.includes(field)) {
      value = toJsonb(value, jsonbFallback[field]);
    }
    if (serialize) value = serialize(field, value);
    values.push(value);
    // A merged jsonb column keeps the keys it already holds; the incoming
    // object wins on the keys it names. `||` on jsonb is a right-biased merge,
    // so the order of the operands is what makes the patch win.
    if (mergeFields.includes(field)) {
      return `${field} = COALESCE(${field}, '{}'::jsonb) || $${values.length}::jsonb`;
    }
    return `${field} = $${values.length}`;
  });

  assignments.push("updated_at = NOW()");

  // The row id is always the next placeholder after the SET values, then the
  // tenant. Both are bound from here rather than by the caller so the numbering
  // cannot drift out of step with the assignments.
  values.push(id);
  let sql = `UPDATE ${table}\n     SET ${assignments.join(", ")}\n     WHERE id = $${values.length}`;
  if (workspaceId !== undefined && workspaceId !== null) {
    values.push(workspaceId);
    // The `default` tenant owns rows written before workspace_id existed, so
    // it also sees them as NULL rather than reporting them as missing.
    sql += ` AND (workspace_id = $${values.length} OR ($${values.length} = 'default' AND workspace_id IS NULL))`;
  }
  sql += "\n     RETURNING *";

  return { sql, values, fields };
}
