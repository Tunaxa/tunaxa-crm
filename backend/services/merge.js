// Atomic duplicate-record merge.
//
// The whole point of this module is that a merge is *one* unit of work. The old
// handler in routes/dataops.js copied fields, re-pointed nothing and deleted the
// duplicate through the JSON store, so any failure halfway through left child
// records (deals, activities, tasks, quotes, ...) attached to a record that no
// longer existed. Here the sequence below - lock, re-point children, update the
// survivor, delete the duplicate, write the audit entry - runs inside a single
// BEGIN/COMMIT on a dedicated pool client. There is no code path that commits
// any subset of it: a throw at any step issues ROLLBACK, which discards the
// re-pointed children along with the field edits.
//
// `dryRun` reuses the same transaction and ends it with ROLLBACK instead, so a
// caller can see exactly what a merge *would* change - including the per-table
// re-point counts - without writing a byte.

import { getPool } from "../db/pg.js";
import { readDb, mutateDb } from "../store.js";
import { auditEntry, now } from "../helpers.js";
import { PG_RESOURCES, pgToLegacy, legacyToPg } from "../db/legacy-shape.js";
import { IMMUTABLE_COLUMNS } from "../db/repositories/update-builder.js";

/** Mergeable resources: name -> table + the singular used in timeline pointers. */
export const MERGE_RESOURCES = new Map([
  ["contacts", { table: "contacts", singular: "contact" }],
  ["companies", { table: "companies", singular: "company" }],
  ["leads", { table: "leads", singular: "lead" }],
]);

// Which kind of parent a pointer column can hold. A contact id can never be
// sitting in a `company_id` column, so the resource being merged decides which
// pointers are worth touching at all - that keeps the transaction down to a
// handful of indexed single-column UPDATEs instead of sweeping every pointer on
// every child table.
const POINTERS = {
  contact: { column: "contact_id", legacyKey: "contactId" },
  company: { column: "company_id", legacyKey: "companyId" },
  deal: { column: "deal_id", legacyKey: "dealId" },
  // `record_id` is the legacy name for the generic timeline pointer;
  // `entity_id` is its normalized twin, and unlike the others it needs a type
  // guard because it is deliberately untyped.
  record: { column: "record_id", legacyKey: "recordId" },
  entity: {
    column: "entity_id",
    legacyKey: "entityId",
    typeColumn: "entity_type",
    typeKey: "entityType",
  },
};

const RESOURCE_POINTERS = {
  contacts: ["contact", "record", "entity"],
  companies: ["company", "record", "entity"],
  // A lead has no dedicated child pointer in this schema (see the deviation
  // table in migration 012), so only the generic timeline pointers follow it.
  leads: ["record", "entity"],
};

// Child tables that can carry a pointer to a merged record. activities *is* the
// notes/timeline table here: migration 005 keeps the legacy `notes` payload in
// the `description` column and has no separate notes table.
const CHILD_TABLES = [
  { table: "activities", pointers: ["contact", "record", "deal", "entity"] },
  { table: "deals", pointers: ["contact", "company"] },
  { table: "tasks", pointers: ["contact", "deal"] },
  { table: "tickets", pointers: ["contact", "company"] },
  { table: "quotes", pointers: ["contact", "company", "deal"] },
  { table: "contracts", pointers: ["contact", "company", "deal"] },
  { table: "orders", pointers: ["contact", "company", "deal"] },
  { table: "invoices", pointers: ["contact", "company", "deal"] },
  { table: "expenses", pointers: ["company", "deal"] },
];

const ACTIVITY_JSONB_COLUMNS = new Set(["metadata", "custom_fields"]);

// Columns a caller may never move through a merge, whatever they put in
// `fieldOverrides`. `updated_at` joins the shared list because the merge sets it
// explicitly; letting a payload win would make the audit stamp meaningless.
const LOCKED_COLUMNS = new Set([...IMMUTABLE_COLUMNS, "updated_at"]);

/** Error carrying the HTTP status the route should answer with. */
export class MergeError extends Error {
  constructor(message, { status = 500, code = "MERGE_FAILED" } = {}) {
    super(message);
    this.name = "MergeError";
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Schema introspection
// ---------------------------------------------------------------------------

// Which pointer columns actually exist varies by table and by migration state:
// `tickets` has no contact_id/company_id column at all (migration 012 lists both
// as deliberate deviations), while every other table on the list has the full
// set. Hardcoding the list would abort the whole transaction with 42703 on a
// real database, and skipping the missing ones by hand means the next migration
// that adds one is silently ignored. Resolving the columns once per process
// keeps the plan honest against whatever schema it is running on.
const columnCache = new Map();

export function clearMergeColumnCache() {
  columnCache.clear();
}

async function columnsOf(client, table) {
  if (columnCache.has(table)) return columnCache.get(table);
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  const columns = new Set(result.rows.map((row) => row.column_name));
  columnCache.set(table, columns);
  return columns;
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

/**
 * Split caller overrides into real column writes and custom-field entries.
 *
 * A key that names no column of this table is a custom attribute rather than a
 * mistake: the REST contract is a flat record, so `loyaltyTier` has to survive
 * the round trip through the `custom_fields` overflow bag. A key that names a
 * server-owned column is dropped instead of written - `workspace_id` is the
 * tenant boundary and must never be client-movable.
 */
function resolveOverrides(fieldOverrides, resource, columns) {
  const supplied = {};
  for (const [key, value] of Object.entries(fieldOverrides || {})) {
    if (LOCKED_COLUMNS.has(key) || value === undefined) continue;
    supplied[key] = value;
  }

  const scalar = {};
  const bag = {};
  const mapped = legacyToPg(supplied, resource, { partial: true });
  for (const [key, value] of Object.entries(mapped)) {
    if (key === "custom_fields" || LOCKED_COLUMNS.has(key)) continue;
    if (value === undefined) continue;
    if (columns.has(key)) scalar[key] = value;
    else bag[key] = value;
  }
  // A caller may also hand over an explicit `{ custom_fields: { ... } }` patch;
  // legacyToPg folds that into mapped.custom_fields, and explicit keys win.
  const explicit = supplied.custom_fields;
  if (explicit && typeof explicit === "object" && !Array.isArray(explicit)) {
    Object.assign(bag, explicit);
  }

  return { scalar, bag };
}

/** Trimmed copy of a row, minus server-owned columns, for the audit payload. */
function snapshotOf(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (LOCKED_COLUMNS.has(key)) continue;
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

function labelOf(row) {
  return (
    row.name ||
    row.title ||
    [row.first_name, row.last_name].filter(Boolean).join(" ") ||
    row.email ||
    String(row.id)
  );
}

// ---------------------------------------------------------------------------
// PostgreSQL path
// ---------------------------------------------------------------------------

/**
 * ROLLBACK without letting a secondary failure replace the original error.
 *
 * Two things make ROLLBACK itself fail: the transaction never started (a
 * connection error on BEGIN), or the connection is already gone. Neither is
 * actionable on top of the exception that got us here, and masking it would
 * hide the real cause.
 */
async function rollbackQuietly(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* no usable transaction left; the error that got us here is the real one */
  }
}

async function reparentChildren(client, { resource, primaryId, secondaryId, workspaceId }) {
  const wanted = RESOURCE_POINTERS[resource] || [];
  const counts = {};
  const byColumn = {};

  for (const child of CHILD_TABLES) {
    const pointers = child.pointers.filter((pointer) => wanted.includes(pointer));
    if (pointers.length === 0) continue;

    const columns = await columnsOf(client, child.table);
    if (columns.size === 0) continue; // table absent on this schema

    for (const pointer of pointers) {
      const spec = POINTERS[pointer];
      if (!columns.has(spec.column)) continue;

      const params = [primaryId, secondaryId, workspaceId];
      const conditions = [
        `${spec.column} = $2`,
        // Same tenant predicate the repositories use: the `default` tenant owns
        // rows written before workspace_id existed. Scoping the re-point is a
        // security property, not an optimisation - without it a merge would
        // re-point another tenant's children.
        `(workspace_id = $3 OR ($3 = 'default' AND workspace_id IS NULL))`,
      ];
      if (spec.typeColumn && columns.has(spec.typeColumn)) {
        params.push(MERGE_RESOURCES.get(resource).singular);
        conditions.push(`${spec.typeColumn} = $${params.length}`);
      }

      const result = await client.query(
        `UPDATE ${child.table}
            SET ${spec.column} = $1
          WHERE ${conditions.join(" AND ")}`,
        params,
      );
      if (result.rowCount > 0) {
        counts[child.table] = (counts[child.table] || 0) + result.rowCount;
        byColumn[child.table] = { ...(byColumn[child.table] || {}), [spec.column]: result.rowCount };
      }
    }
  }

  return { counts, byColumn };
}

/**
 * Apply the merge to the survivor.
 *
 * `secondary || primary || overrides` is a right-biased jsonb merge, so the
 * survivor's own keys win over the duplicate's (which is what "preserve primary,
 * adopt what the secondary adds" means) and the caller's explicit overrides win
 * over both. Reading the duplicate from the same statement's FROM clause means
 * the value merged in is the row we locked at the top of the transaction, not a
 * second read that could see a different one.
 */
async function updatePrimary(client, { table, primaryId, secondaryId, scalar, bag }) {
  const values = [primaryId, secondaryId];
  const assignments = [];

  values.push(JSON.stringify(bag));
  assignments.push(
    `custom_fields = COALESCE(s.custom_fields, '{}'::jsonb) || COALESCE(p.custom_fields, '{}'::jsonb) || $${values.length}::jsonb`,
  );

  for (const [column, value] of Object.entries(scalar)) {
    values.push(value);
    // Target columns are never table-qualified: PostgreSQL rejects
    // `SET table.column = ...`.
    assignments.push(`${column} = $${values.length}`);
  }
  assignments.push("updated_at = NOW()");

  const result = await client.query(
    `UPDATE ${table} AS p
        SET ${assignments.join(", ")}
       FROM ${table} AS s
      WHERE p.id = $1 AND s.id = $2
      RETURNING p.*`,
    values,
  );
  return result.rows[0] || null;
}

async function deleteSecondary(client, { table, secondaryId, workspaceId }) {
  const result = await client.query(
    `DELETE FROM ${table}
      WHERE id = $1
        AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL))
      RETURNING id`,
    [secondaryId, workspaceId],
  );
  return result.rowCount > 0;
}

/**
 * Record the merge on the surviving record's timeline.
 *
 * `db.audit` is JSON-store only (routes/audit.js reads it with no Postgres
 * path), so the durable, tenant-scoped trail is an activities row. It is
 * inserted after the re-point so its own pointers are already on the survivor
 * and never need moving. Everything the caller needs to reconstruct or undo the
 * merge - the duplicate's full row, the overrides, the per-table counts - goes
 * into `metadata`.
 */
async function writeAuditActivity(client, { resource, singular, primary, secondary, overrides, repointed, workspaceId, actor, dryRun }) {
  const columns = await columnsOf(client, "activities");
  if (!columns.has("metadata")) return null;

  const metadata = {
    merge: {
      resource,
      actor: actor || null,
      dryRun,
      primaryId: String(primary.id),
      secondaryId: String(secondary.id),
      fieldOverrides: { ...overrides.scalar, ...overrides.bag },
      repointedCounts: repointed.counts,
      repointedByColumn: repointed.byColumn,
      mergedSecondary: snapshotOf(secondary),
    },
  };

  const row = {
    workspace_id: workspaceId,
    type: "Merge",
    title: `Merged ${labelOf(secondary)} into ${labelOf(primary)}`,
    description: `Duplicate ${singular} ${secondary.id} was merged into ${primary.id}. ${Object.entries(repointed.counts).map(([table, n]) => `${n} ${table}`).join(", ") || "No child records re-pointed"}.`,
    record_id: String(primary.id),
    entity_type: singular,
    entity_id: String(primary.id),
    metadata: JSON.stringify(metadata),
    custom_fields: JSON.stringify({}),
  };
  if (resource === "contacts") {
    row.contact = labelOf(primary);
    row.contact_id = String(primary.id);
  }
  if (resource === "companies") row.company = labelOf(primary);

  const columns2 = Object.keys(row).filter((column) => columns.has(column));
  const placeholders = columns2.map(
    (column, index) =>
      `$${index + 1}${ACTIVITY_JSONB_COLUMNS.has(column) ? "::jsonb" : ""}`,
  );
  const result = await client.query(
    `INSERT INTO activities (${columns2.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING id`,
    columns2.map((column) => row[column]),
  );
  return result.rows[0]?.id || null;
}

async function mergeInPostgres({ resource, primaryId, secondaryId, fieldOverrides, workspaceId, dryRun, actor }) {
  const { table, singular } = MERGE_RESOURCES.get(resource);
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    // FOR UPDATE on both rows, scoped to the tenant. Everything below runs
    // against rows this transaction owns, so a concurrent merge of the same
    // pair serialises here instead of interleaving two field resolutions over
    // one record.
    const locked = await client.query(
      `SELECT * FROM ${table}
        WHERE id IN ($1, $2)
          AND (workspace_id = $3 OR ($3 = 'default' AND workspace_id IS NULL))
        FOR UPDATE`,
      [primaryId, secondaryId, workspaceId],
    );
    const rows = new Map(locked.rows.map((row) => [String(row.id), row]));
    const primary = rows.get(String(primaryId));
    const secondary = rows.get(String(secondaryId));
    // Same answer whether the row is missing outright or belongs to another
    // tenant: reporting that difference would confirm the existence of another
    // tenant's record.
    if (!primary || !secondary) {
      throw new MergeError("One or both records not found", {
        status: 404,
        code: "NOT_FOUND",
      });
    }

    const columns = await columnsOf(client, table);
    const overrides = resolveOverrides(fieldOverrides, resource, columns);
    const repointed = await reparentChildren(client, {
      resource,
      primaryId: String(primary.id),
      secondaryId: String(secondary.id),
      workspaceId,
    });
    const merged = await updatePrimary(client, {
      table,
      primaryId: String(primary.id),
      secondaryId: String(secondary.id),
      scalar: overrides.scalar,
      bag: overrides.bag,
    });
    const deletedSecondary = await deleteSecondary(client, { table, secondaryId: String(secondary.id), workspaceId });
    // Both rows are locked and still present, so the UPDATE above cannot miss.
    // If it somehow did, the survivor would be about to be deleted and the
    // result would report a merge that never happened - fail instead.
    if (!merged) {
      throw new MergeError("Merge target disappeared mid-transaction", {
        status: 409,
        code: "MERGE_TARGET_MISSING",
      });
    }
    const auditActivityId = await writeAuditActivity(client, {
      resource,
      singular,
      primary,
      secondary,
      overrides,
      repointed,
      workspaceId,
      actor,
      dryRun,
    });

    // dryRun takes the same path and throws the work away at the end, so the
    // preview cannot drift from what a real merge would do.
    if (dryRun) await client.query("ROLLBACK");
    else await client.query("COMMIT");

    return {
      success: true,
      dryRun,
      mode: "pg",
      resource,
      mergedRecord: pgToLegacy(merged, resource),
      repointedCounts: repointed.counts,
      repointedByColumn: repointed.byColumn,
      fieldOverrides: { ...overrides.scalar, ...overrides.bag },
      mergedSecondaryId: String(secondary.id),
      deletedSecondary,
      auditActivityId,
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// JSON-store path
// ---------------------------------------------------------------------------

// Mirrors reparentChildren() for a deployment running off the JSON store.
// The legacy flat records carry camelCase pointer keys, not column names.
function reparentChildrenJson(db, { resource, primaryId, secondaryId, workspaceId }) {
  const wanted = RESOURCE_POINTERS[resource] || [];
  const counts = {};
  const byColumn = {};

  for (const child of CHILD_TABLES) {
    const pointers = child.pointers.filter((pointer) => wanted.includes(pointer));
    if (pointers.length === 0) continue;
    const rows = db[child.table] || [];

    for (const pointer of pointers) {
      const spec = POINTERS[pointer];
      let moved = 0;
      for (const row of rows) {
        if (row[spec.legacyKey] !== secondaryId) continue;
        const owner = row.workspaceId ?? row.workspace_id;
        if (owner != null && String(owner) !== String(workspaceId)) continue;
        if (spec.typeKey && row[spec.typeKey] && row[spec.typeKey] !== MERGE_RESOURCES.get(resource).singular) {
          continue;
        }
        row[spec.legacyKey] = primaryId;
        moved++;
      }
      if (moved > 0) {
        counts[child.table] = (counts[child.table] || 0) + moved;
        byColumn[child.table] = { ...(byColumn[child.table] || {}), [spec.column]: moved };
      }
    }
  }

  return { counts, byColumn };
}

function applyJsonMerge(db, { resource, primaryId, secondaryId, fieldOverrides, workspaceId, actor }) {
  const rows = db[resource] || [];
  const primaryIndex = rows.findIndex((row) => row.id === primaryId);
  const secondaryIndex = rows.findIndex((row) => row.id === secondaryId);
  if (primaryIndex < 0 || secondaryIndex < 0) {
    throw new MergeError("One or both records not found", { status: 404, code: "NOT_FOUND" });
  }
  const primary = rows[primaryIndex];
  const secondary = rows[secondaryIndex];

  // The JSON store has no workspace column, so a row only carries a tenant when
  // something put one there. Check it when present and otherwise treat the
  // record as belonging to the caller's tenant, which is how routes/resources.js
  // reads these records.
  for (const row of [primary, secondary]) {
    const owner = row.workspaceId ?? row.workspace_id;
    if (owner != null && String(owner) !== String(workspaceId)) {
      throw new MergeError("One or both records not found", { status: 404, code: "NOT_FOUND" });
    }
  }

  const overrides = resolveOverrides(
    fieldOverrides,
    resource,
    new Set([
      "id",
      "name",
      "title",
      "email",
      "phone",
      "company",
      "company_id",
      "company_name",
      "domain",
      "website",
      "industry",
      "country",
      "size",
      "status",
      "source",
      "value",
      "owner",
      "title",
      "role",
      "first_name",
      "last_name",
    ]),
  );

  for (const [key, value] of Object.entries(overrides.scalar)) primary[key] = value;
  primary.custom_fields = {
    ...(secondary.custom_fields || {}),
    ...(primary.custom_fields || {}),
    ...overrides.bag,
  };

  const repointed = reparentChildrenJson(db, {
    resource,
    primaryId: primary.id,
    secondaryId: secondary.id,
    workspaceId,
  });

  db[resource] = rows.filter((row) => row.id !== secondary.id);
  primary.updatedAt = now();

  db.audit = db.audit || [];
  db.audit.unshift({
    ...auditEntry({
      action: `Merged ${resource.replace(/s$/, "")} ${secondary.id} into ${primary.id}`,
      actor: actor || "system",
      resourceId: String(primary.id),
    }),
    merge: {
      resource,
      secondaryId: String(secondary.id),
      repointedCounts: repointed.counts,
    },
  });

  return { primary, secondary, overrides, repointed };
}

async function mergeInJsonStore({ resource, primaryId, secondaryId, fieldOverrides, workspaceId, dryRun, actor }) {
  const run = (db) =>
    applyJsonMerge(db, { resource, primaryId, secondaryId, fieldOverrides, workspaceId, actor });

  if (dryRun) {
    // readDb() parses the file into a fresh object, so mutating it writes
    // nothing. That is the JSON equivalent of ROLLBACK.
    const preview = run(await readDb());
    return {
      success: true,
      dryRun: true,
      mode: "json",
      resource,
      mergedRecord: preview.primary,
      repointedCounts: preview.repointed.counts,
      repointedByColumn: preview.repointed.byColumn,
      fieldOverrides: { ...preview.overrides.scalar, ...preview.overrides.bag },
      mergedSecondaryId: String(preview.secondary.id),
      deletedSecondary: true,
      auditActivityId: null,
    };
  }

  // mutateDb() writes the file only after the mutator resolves, so a throw
  // anywhere above leaves the previous file in place - the whole mutation is
  // discarded, not just the failing step.
  const result = await mutateDb((db) => run(db));
  return {
    success: true,
    dryRun: false,
    mode: "json",
    resource,
    mergedRecord: result.primary,
    repointedCounts: result.repointed.counts,
    repointedByColumn: result.repointed.byColumn,
    fieldOverrides: { ...result.overrides.scalar, ...result.overrides.bag },
    mergedSecondaryId: String(result.secondary.id),
    deletedSecondary: true,
    auditActivityId: null,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Merge `secondaryId` into `primaryId` as one atomic unit.
 *
 * The survivor keeps its own scalar values unless `fieldOverrides` names a
 * field; `custom_fields` is shallow-merged with the survivor winning on
 * conflicts. Every child pointer moves to the survivor and the duplicate is
 * deleted, all inside one transaction.
 *
 * `mode: "auto"` uses Postgres for anything in PG_RESOURCES (which is all three
 * mergeable resources) and the JSON store otherwise. It deliberately does *not*
 * fall back to the JSON store when Postgres is unreachable: a merge that only
 * lands in the JSON file looks successful while the database keeps the
 * duplicate, which is the exact split-brain this engine exists to prevent.
 *
 * @throws {MergeError} with `status` 400 (bad request) or 404 (missing row,
 *   or a row belonging to another tenant).
 */
export async function mergeRecords({
  resource,
  primaryId,
  secondaryId,
  fieldOverrides = {},
  workspaceId = "default",
  dryRun = false,
  actor = null,
  mode = "auto",
} = {}) {
  const spec = MERGE_RESOURCES.get(resource);
  if (!spec) {
    throw new MergeError(`resource must be one of: ${[...MERGE_RESOURCES.keys()].join(", ")}`, {
      status: 400,
      code: "INVALID_RESOURCE",
    });
  }
  if (!primaryId || !secondaryId) {
    throw new MergeError("primaryId and secondaryId are required", {
      status: 400,
      code: "MISSING_IDS",
    });
  }
  if (String(primaryId) === String(secondaryId)) {
    throw new MergeError("primaryId and secondaryId must be different records", {
      status: 400,
      code: "SAME_RECORD",
    });
  }

  const args = {
    resource,
    primaryId: String(primaryId),
    secondaryId: String(secondaryId),
    fieldOverrides: fieldOverrides || {},
    workspaceId: workspaceId ?? "default",
    dryRun: dryRun === true,
    actor,
  };
  const usePostgres = mode === "pg" || (mode === "auto" && PG_RESOURCES.has(resource));
  return usePostgres ? mergeInPostgres(args) : mergeInJsonStore(args);
}
