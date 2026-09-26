/**
 * Backfill the marketing & service tables (migration 007) from the legacy JSON
 * store.
 *
 *   node scripts/migrate-marketing-service-to-pg.js
 *
 * Idempotent: every write is an INSERT ... ON CONFLICT (id) DO UPDATE, so a
 * second run converges the same rows instead of duplicating them.
 *
 * Deliberately NOT `await import("../backend/db/seed.js")`: that module is an
 * executable script, not a data module. It has no exports and its top-level
 * `await mutateDb(...)` writes to backend/data/db.json on import, so importing
 * it from a migration would have the migration mutate its own source data as a
 * side effect. It also declares none of these six entities (only users,
 * contacts, leads, companies, deals, tasks, activities), so there would be
 * nothing there to fall back to in the first place. This is why there is no
 * seedFallback() equivalent to the revenue script's.
 *
 * Structural sibling of scripts/migrate-revenue-to-pg.js; the differences are
 * the key aliases below and the entity-specific field maps.
 */

import { readDb } from "../backend/store.js";
import { getPool, closePool } from "../backend/db/pg.js";

/**
 * Columns per entity as [legacyKey, column, kind].
 *
 * Several legacy keys alias to one column (name/title, respondent/email, ...);
 * buildRow keeps the first mapping that yields a value, in declaration order.
 *
 * kind: "text" | "money" (double precision) | "number" (integer) | "bool" |
 *       "date" (timestamptz) | "json:<key>" (JSONB column, see jsonColumns)
 */
const ENTITIES = {
  campaigns: {
    keys: ["campaigns"],
    columns: [
      ["name", "name", "text"],
      // Legacy keys the channel `channel`; `type` is the spec name but nothing
      // in the app writes it. Kept as an alias so both land in one column.
      ["channel", "channel", "text"],
      ["type", "channel", "text"],
      ["status", "status", "text"],
      ["description", "description", "text"],
      ["budget", "budget", "money"],
      ["spend", "spend", "money"],
      ["target", "target", "money"],
      ["reached", "reached", "money"],
      ["leads", "leads", "money"],
      ["startDate", "start_date", "date"],
      ["endDate", "end_date", "date"],
    ],
    json: [
      ["metrics", "metrics", {}],
    ],
  },

  email_lists: {
    // The store key is camelCase; the snake_case form is accepted too so the
    // script keeps working if the key is ever normalized.
    keys: ["emailLists", "email_lists"],
    columns: [
      ["name", "name", "text"],
      ["description", "description", "text"],
      ["status", "status", "text"],
      // A count, not an address list. helpers.js coerces it with Number().
      ["subscribers", "subscribers", "number"],
      ["subscriberCount", "subscribers", "number"],
    ],
  },

  forms: {
    // `forms` is lazily vivified by routes/forms.js and is absent from both
    // db.json and db.json.bac, hence the `|| []` in main().
    keys: ["forms"],
    columns: [
      ["name", "name", "text"],
      ["title", "title", "text"],
      ["description", "description", "text"],
      ["permalink", "permalink", "text"],
      ["submitTo", "submit_to", "text"],
      ["progressive", "progressive", "bool"],
      ["redirectUrl", "redirect_url", "text"],
      ["enabled", "enabled", "bool"],
      ["submissionCount", "submission_count", "number"],
      ["createdBy", "created_by", "text"],
    ],
    json: [
      ["fields", "fields", []],
      ["settings", "settings", {}],
    ],
  },

  tickets: {
    // Also lazily vivified, and absent from the store until the first POST.
    keys: ["tickets"],
    columns: [
      ["subject", "subject", "text"],
      ["title", "subject", "text"], // fallback label, if a caller used one
      ["description", "description", "text"],
      // stage, not status: routes/tickets.js slaStatus() branches on it.
      ["stage", "stage", "text"],
      ["priority", "priority", "text"],
      ["source", "source", "text"],
      ["contact", "contact", "text"],
      ["contactEmail", "contact_email", "text"],
      ["resolvedBy", "resolved_by", "text"],
      ["status", "status", "text"],
      ["firstResponseAt", "first_response_at", "date"],
      ["resolvedAt", "resolved_at", "date"],
    ],
    json: [
      ["comments", "comments", []],
    ],
  },

  surveys: {
    keys: ["surveys"],
    columns: [
      // name is the required UI field; title is kept as a nullable alias.
      ["name", "name", "text"],
      ["title", "name", "text"],
      ["description", "description", "text"],
      ["type", "type", "text"],
      ["question", "question", "text"],
      ["audience", "audience", "text"],
      ["targetScore", "target_score", "money"],
      ["status", "status", "text"],
    ],
    json: [
      ["questions", "questions", []],
    ],
  },

  survey_responses: {
    keys: ["surveyResponses", "survey_responses"],
    columns: [
      // `survey` holds a survey name, not an id.
      ["survey", "survey", "text"],
      ["surveyId", "survey_id", "text"],
      ["respondent", "respondent", "text"],
      ["respondentEmail", "respondent_email", "text"],
      ["score", "score", "money"],
      ["comment", "comment", "text"],
      ["date", "submitted_at", "date"],
      ["submittedAt", "submitted_at", "date"],
    ],
    json: [
      ["responses", "responses", {}],
      ["answers", "responses", {}],
    ],
  },
};

/**
 * NOT NULL label columns need a value even when the source lacks one.
 * Surveys and forms can arrive with neither `name` nor `title` populated.
 */
const LABEL_FALLBACKS = {
  campaigns: ["name", "title", "description", "channel"],
  email_lists: ["name", "title", "description"],
  forms: ["name", "title", "permalink", "description"],
  tickets: ["subject", "title", "description", "contactEmail", "contact"],
  surveys: ["name", "title", "question", "audience"],
};

/**
 * The NOT NULL label column each entity needs, and the legacy keys to try when
 * the source lacks it.
 *
 * tickets.subject is included deliberately: routes/tickets.js rejects a POST
 * without a subject, but PUT merges the raw body, so a stored record can in
 * principle have lost it. A row that still has no subject after the fallback
 * chain is reported and skipped rather than aborting the run - see buildRow.
 */
const LABEL_COLUMN = {
  campaigns: "name",
  email_lists: "name",
  forms: "name",
  tickets: "subject",
  surveys: "name",
};

/**
 * Schema defaults mirrored in JS, per column.
 *
 * A column with a DEFAULT must not be bound at all when the legacy record has
 * no value for it: node-postgres would send an explicit NULL, and an explicit
 * NULL overrides the DEFAULT rather than falling back to it. routes/forms.js
 * always writes progressive/enabled, but a record that predates those fields -
 * or one written by the raw Object.assign in PUT /api/forms/:id - will not
 * have them, and must land on the same value a fresh INSERT would.
 *
 * The rule is "no source key present at all", not "value was empty": an empty
 * string is a real legacy value and stays NULL.
 */
const DEFAULTS = {
  campaigns: { status: "Draft" },
  email_lists: { status: "Draft", subscribers: 0 },
  forms: { submit_to: "lead", progressive: true, enabled: true, submission_count: 0 },
  tickets: { stage: "New", priority: "Normal", source: "Email" },
  surveys: { status: "Draft" },
  survey_responses: {},
};

const SYSTEM_FIELDS = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "workspaceId",
  "_workflow",
]);

/** Normalize a legacy value to what the target column type expects. */
function coerce(value, kind) {
  if (value === undefined || value === null || value === "") return null;
  if (kind === "money") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (kind === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (kind === "bool") {
    if (typeof value === "boolean") return value;
    const s = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(s)) return true;
    if (["false", "0", "no", "n", "off"].includes(s)) return false;
    return null;
  }
  if (kind === "date") {
    // A blank string is not a date: timestamptz rejects '' with 22007, so it
    // has to become NULL rather than reach the driver. This matters here
    // because routes/tickets.js initializes firstResponseAt/resolvedAt to ''
    // rather than null.
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (kind === "text") {
    if (typeof value === "object") return null;
    return String(value);
  }
  return value;
}

/**
 * Coerce a value destined for a JSONB column.
 *
 * Always returns a value, never undefined: the column is NOT NULL with a
 * default, and an absent key must fall back to that default rather than
 * becoming SQL NULL.
 */
function coerceJson(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return JSON.stringify(fallback);
  }
  if (typeof value === "string") {
    // Already serialized by an earlier run, or a raw JSON payload.
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}
function buildRow(entity, record, config) {
  const row = { custom_fields: {} };
  const handled = new Set(SYSTEM_FIELDS);
  // Columns fed by at least one key that the source record actually has, so the
  // DEFAULTS pass below knows what it must not overwrite.
  const supplied = new Set();

  for (const [key, column, kind] of config.columns) {
    handled.add(key);
    if (row[column] !== undefined) continue; // first mapping wins
    const coerced = coerce(record[key], kind);
    if (coerced !== null) row[column] = coerced;
    // `key in record` rather than `coerced !== null`: a present-but-blank key is
    // an explicit legacy value and must stay NULL instead of picking up a default.
    if (key in record) supplied.add(column);
  }

  for (const [column, value] of Object.entries(DEFAULTS[entity] || {})) {
    if (!supplied.has(column)) row[column] = value;
  }

  // Columns whose JSONB value came from a real, present source key. An alias may
  // only fill a column that is still holding nothing but the default below, so
  // `answers` can supply `responses` when the record has no `responses` key.
  const jsonFilled = new Set();
  for (const [key, column, fallback] of config.json || []) {
    handled.add(key);
    if (jsonFilled.has(column)) continue; // a real value already won
    const present =
      key in record && record[key] !== undefined && record[key] !== null && record[key] !== "";
    row[column] = coerceJson(present ? record[key] : undefined, fallback);
    if (present) jsonFilled.add(column);
  }

  // NOT NULL label columns need a value even when the source lacks one.
  const labelColumn = LABEL_COLUMN[entity];
  if (labelColumn && row[labelColumn] === undefined) {
    for (const key of LABEL_FALLBACKS[entity] || []) {
      const candidate = coerce(record[key], "text");
      if (candidate) {
        row[labelColumn] = candidate;
        break;
      }
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (handled.has(key) || value === undefined || value === null || value === "") continue;
    row.custom_fields[key] = value;
  }
  if (Object.keys(row.custom_fields).length === 0) row.custom_fields = {};

  return row;
}

/**
 * True when the row can satisfy every NOT NULL-without-default column.
 *
 * A missing label must not abort the migration: these tables may legitimately
 * end up with a handful of bad legacy records, and failing the whole
 * transaction would leave all six tables unbackfilled because of one. The row
 * is skipped and reported instead, so the operator can inspect it.
 */
function isInsertable(entity, row) {
  const label = LABEL_COLUMN[entity];
  if (label && (row[label] === undefined || row[label] === null)) return false;
  return true;
}

/** Distinct column list for an entity, in declaration order. */
function columnNames(config) {
  const columns = [];
  for (const [, column] of config.columns) {
    if (!columns.includes(column)) columns.push(column);
  }
  for (const [, column] of config.json || []) {
    if (!columns.includes(column)) columns.push(column);
  }
  return columns;
}

/**
 * Insert-only columns, appended after the mapped ones.
 *
 * created_at/updated_at are set here rather than left to the column defaults,
 * because a backfill that stamps every historical record with NOW() destroys the
 * only record of when the data was actually captured.
 */
const TIMESTAMP_COLUMNS = ["created_at", "updated_at"];

function updateSet(config) {
  // custom_fields is listed explicitly; Postgres rejects an assignment list
  // that names the same column twice, so dedupe everything.
  const set = ["workspace_id = EXCLUDED.workspace_id", "custom_fields = EXCLUDED.custom_fields"];
  for (const column of columnNames(config)) {
    if (column === "custom_fields") continue;
    set.push(`${column} = EXCLUDED.${column}`);
  }
  // created_at is deliberately absent: a re-run must not restamp a record's
  // original creation time. updated_at is absent too - the
  // update_updated_at_column() BEFORE UPDATE trigger sets it on every write, so
  // assigning it here would be immediately overwritten anyway.
  return set.join(", ");
}

async function upsert(client, table, config, rows) {
  const columns = columnNames(config);
  const insertColumns = ["id", ...columns, ...TIMESTAMP_COLUMNS, "workspace_id", "custom_fields"];
  const placeholders = insertColumns.map((_, i) => `$${i + 1}`).join(", ");
  const sql =
    `INSERT INTO ${table} (${insertColumns.join(", ")}) VALUES (${placeholders}) ` +
    `ON CONFLICT (id) DO UPDATE SET ${updateSet(config)}`;

  for (const row of rows) {
    const record = { id: row.id, workspace_id: row.workspace_id || "default" };
    for (const column of columns) {
      if (column === "id" || column === "workspace_id") continue;
      record[column] = row[column] === undefined ? null : row[column];
    }
    record.created_at = row.created_at;
    record.updated_at = row.updated_at;
    record.custom_fields = JSON.stringify(row.custom_fields || {});
    await client.query(sql, insertColumns.map((c) => record[c] ?? null));
  }
  return rows.length;
}

async function main() {
  const {
    PGHOST = "127.0.0.1",
    PGPORT = "5432",
    PGDATABASE = "tunaxa",
    PGUSER = "postgres",
  } = process.env;
  console.log(`Target: ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}`);

  const db = await readDb();
  const client = await getPool().connect();
  const summary = [];

  try {
    await client.query("BEGIN");

    for (const [entity, config] of Object.entries(ENTITIES)) {
      const started = Date.now();
      // `db.forms` and `db.tickets` are created lazily by their route modules
      // and are absent from db.json until the first POST, so this must tolerate
      // a missing key rather than reading it directly.
      let source = [];
      let usedKey = null;
      for (const key of config.keys) {
        if (Array.isArray(db[key])) {
          source = db[key];
          usedKey = key;
          break;
        }
      }

      const rows = [];
      const skipped = [];
      for (const record of source) {
        const row = buildRow(entity, record, config);
        row.id = record.id ? String(record.id) : null;
        // A row is only skipped for a missing id or an unsatisfiable NOT NULL
        // label; both are reported rather than thrown, so one bad legacy record
        // cannot roll back the other five tables.
        if (!row.id || !isInsertable(entity, row)) {
          skipped.push(record.id || "(no id)");
          continue;
        }
        row.workspace_id = record.workspaceId || "default";
        row.created_at = coerce(record.createdAt, "date") || new Date().toISOString();
        row.updated_at = coerce(record.updatedAt, "date") || row.created_at;
        rows.push(row);
      }

      const written = rows.length ? await upsert(client, entity, config, rows) : 0;
      const elapsed = Date.now() - started;
      summary.push({ entity, source: usedKey, read: source.length, written, skipped: skipped.length });
      console.log(
        `  ${entity.padEnd(17)} read ${String(source.length).padStart(4)}  ` +
          `written ${String(written).padStart(4)}  skipped ${String(skipped.length).padStart(3)}  ` +
          `(${elapsed} ms, from ${usedKey || "no such key"})`,
      );
      for (const why of skipped) {
        console.log(`      skipped ${why}: missing id or required label`);
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\nMigration failed [${error.code || "no code"}]: ${error.message}`);
    if (error.position) console.error(`  at statement position ${error.position}`);
    client.release();
    await closePool().catch(() => {});
    process.exit(1);
  }

  client.release();

  const total = summary.reduce((n, s) => n + s.written, 0);
  console.log(`\nMigrated ${total} row(s) across ${summary.length} table(s).`);
  if (total === 0) {
    console.log(
      "Source arrays were empty. `forms` and `tickets` are absent from db.json " +
        "until the app creates the first record, which is expected.",
    );
  }
  console.log(
    `Re-running is safe: the upsert keys on id, so a second run converges the ` +
      `same rows instead of duplicating them.`,
  );
  await closePool();
}

await main();
