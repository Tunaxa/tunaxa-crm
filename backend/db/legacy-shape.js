// ---------- PG ↔ legacy-JSON shape adapters ----------
// The REST API surface and test suite use the legacy flat schema:
//   { id, name, email, phone, status, value, createdAt, updatedAt, ... }
// The PG repositories use snake_case column names.
// These helpers translate in both directions so all existing callers
// continue to work unchanged.
//
// Pure functions with no dependencies, so both route modules can share them
// without importing each other.

/**
 * Resources whose rows live in Postgres rather than the JSON store. Both the
 * write path (routes/resources.js) and the read path that duplicate detection
 * depends on (routes/dataops.js) must agree on this set; keeping one copy here
 * is what stops the two from drifting apart again.
 */
export const PG_RESOURCES = new Set([
  "contacts",
  "leads",
  "companies",
  "deals",
  "tasks",
  "activities",
]);

/**
 * Per-resource column knowledge for the four core entities.
 *
 * `columns` is the authoritative column list for the table (see
 * migrations/005_core_entities.sql). It is what decides whether an incoming
 * field becomes a real column or an entry in the custom_fields overflow bag:
 *
 *   - a key in `columns` is stored in that column, so it stays queryable,
 *     sortable and indexable;
 *   - anything else (activity `date`/`callId`/`messageId`/`workflowId`, custom
 *     fields, ...) is stored in `custom_fields` and merged back out on read, so
 *     the flat legacy record survives the round trip without a migration per
 *     field the app happens to write somewhere.
 *
 * `toPg` / `toLegacy` are the renames between the legacy camelCase key and the
 * column name. `hidden` columns are stored but never exposed in a response.
 */
const RESOURCE_MAPPINGS = {
  companies: {
    columns: [
      "workspace_id",
      "name",
      "domain",
      "industry",
      "website",
      "country",
      "size",
      "employees",
      "owner",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: { createdAt: "created_at", updatedAt: "updated_at" },
    toLegacy: { created_at: "createdAt", updated_at: "updatedAt" },
    hidden: ["workspace_id", "custom_fields"],
  },
  deals: {
    columns: [
      "workspace_id",
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
      "created_at",
      "updated_at",
    ],
    // `name` is the deal name; `title` is the column and the legacy key.
    // Accepting `name` on write keeps CSV import and older clients working.
    toPg: {
      name: "title",
      companyId: "company_id",
      contactId: "contact_id",
      pipelineId: "pipeline_id",
      closeDate: "expected_close_date",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      company_id: "companyId",
      contact_id: "contactId",
      pipeline_id: "pipelineId",
      expected_close_date: "closeDate",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
    extraLegacy: { title: "name" },
  },
  tasks: {
    columns: [
      "workspace_id",
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
      "created_at",
      "updated_at",
    ],
    toPg: {
      notes: "description",
      dueDate: "due_date",
      assignedTo: "assigned_to",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      due_date: "dueDate",
      assigned_to: "assignedTo",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
  },
  activities: {
    columns: [
      "workspace_id",
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
      "created_at",
      "updated_at",
    ],
    // `notes` is the legacy name for the description text, and `recordId` the
    // legacy name for the entity pointer.
    toPg: {
      notes: "description",
      recordId: "record_id",
      entityType: "entity_type",
      entityId: "entity_id",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      record_id: "recordId",
      entity_type: "entityType",
      entity_id: "entityId",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields", "metadata"],
    // The timeline UI and reports read `notes`, so it stays in the response
    // alongside the `description` column it is stored in.
    extraLegacy: { description: "notes" },
  },
};

/**
 * `toPg` and `toLegacy` are separate on purpose: a rename is not always its own
 * inverse. `dueDate` ↔ `due_date` is, but `name` → the `title` column is not -
 * deals answer with `title` *and* `name`, so the reverse direction has to be
 * spelled out rather than derived.
 */
function mappingFor(resource) {
  const mapping = (resource && RESOURCE_MAPPINGS[resource]) || null;
  if (mapping && !mapping.columnSet) mapping.columnSet = new Set(mapping.columns);
  return mapping;
}

/** Convert a PG timestamp value to the ISO string the legacy contract expects. */
function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

// Columns the database types as a timestamp or date. A legacy caller may send an
// empty string to mean "no date set" - the JSON store accepted that, but
// PostgreSQL rejects '' for timestamptz with 22007, so blank those to NULL.
const TEMPORAL_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "due_date",
  "expected_close_date",
  "date",
]);

/** Coerce a legacy date value to something the timestamptz column accepts. */
function normalizeTemporalValue(value) {
  if (value === "" || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Convert a PG row (snake_case, Dates) → legacy API shape (camelCase strings).
 * `name` is reconstructed from first_name / last_name when available.
 *
 * `resource` is optional. The four core entities need the column knowledge in
 * RESOURCE_MAPPINGS; contacts and leads predate the mapping and rely on the
 * generic snake_case passthrough below.
 */
export function pgToLegacy(row, resource) {
  if (!row) return null;
  const mapping = mappingFor(resource);
  if (!mapping) return genericPgToLegacy(row);

  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (mapping.hidden.includes(key)) continue;
    const legacyKey = mapping.toLegacy[key] || key;
    if (value == null && (key === "created_at" || key === "updated_at")) {
      continue;
    }
    // PG hands back Date objects; the legacy contract is ISO strings. This
    // covers created_at/updated_at and every other timestamp column
    // (due_date, expected_close_date, ...) that res.json would otherwise have
    // to serialize for us.
    out[legacyKey] = value instanceof Date ? toIsoString(value) : value;
  }

  // Overflow bag last, so a real column always wins over a bag entry that
  // happens to share its name.
  const extra = row.custom_fields;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (!(key in out)) out[key] = value;
    }
  }

  for (const [column, legacyKey] of Object.entries(mapping.extraLegacy || {})) {
    if (out[column] != null && out[legacyKey] === undefined) {
      out[legacyKey] = out[column];
    }
  }

  return out;
}

/**
 * Legacy behaviour for contacts and leads: strip the snake_case timestamps,
 * rebuild `name` from first_name / last_name, pass everything else through.
 */
function genericPgToLegacy(row) {
  const out = { ...row };
  if (out.created_at instanceof Date) {
    out.createdAt = out.created_at.toISOString();
  } else if (out.created_at) {
    out.createdAt = String(out.created_at);
  }
  if (out.updated_at instanceof Date) {
    out.updatedAt = out.updated_at.toISOString();
  } else if (out.updated_at) {
    out.updatedAt = String(out.updated_at);
  }
  delete out.created_at;
  delete out.updated_at;
  // Reconstruct `name` from first_name / last_name for backward compat
  if (out.first_name !== undefined || out.last_name !== undefined) {
    const parts = [out.first_name, out.last_name].filter(Boolean);
    out.name = parts.join(" ") || out.first_name || "";
  }
  return out;
}

/**
 * Convert an incoming legacy request body → PG repository input.
 * Splits `name` into first_name / last_name for contacts and leads; routes
 * known camelCase keys to their column and everything else into the
 * custom_fields bag for the four core entities.
 */
export function legacyToPg(body, resource) {
  const mapping = mappingFor(resource);
  if (!mapping) return genericLegacyToPg(body);

  const out = {};
  const extra = {};
  for (const [key, value] of Object.entries(body || {})) {
    // The database owns the id and both timestamps: a client-supplied value
    // would either be rejected or pin updated_at forever.
    if (key === "id" || key === "createdAt" || key === "updatedAt") continue;
    if (key === "custom_fields") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(extra, value);
      }
      continue;
    }
    const column = mapping.toPg[key] || key;
    if (mapping.columnSet.has(column) && column !== "custom_fields") {
      out[column] = TEMPORAL_COLUMNS.has(column) ? normalizeTemporalValue(value) : value;
    } else {
      extra[key] = value;
    }
  }

  // Left unset when empty so a partial PUT does not wipe the stored bag.
  if (Object.keys(extra).length) out.custom_fields = extra;
  return out;
}

function genericLegacyToPg(body) {
  const out = { ...body };
  if ("name" in out) {
    const parts = String(out.name || "").trim().split(/\s+/);
    out.first_name = parts[0] || "";
    out.last_name = parts.slice(1).join(" ") || undefined;
    delete out.name;
  }
  // Drop camelCase timestamp fields if accidentally sent in body
  delete out.createdAt;
  delete out.updatedAt;
  return out;
}
