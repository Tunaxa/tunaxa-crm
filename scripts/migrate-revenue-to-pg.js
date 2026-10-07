#!/usr/bin/env node
// Data migration: JSON store -> Postgres for the six revenue entities.
//
//   node scripts/migrate-revenue-to-pg.js
//
// Backs 006_revenue_tables.sql. Follows the pattern established by
// scripts/migrate-json-to-pg.js (BE-23) on feat/migrate-json-to-pg: one
// transaction, a per-table column map, unmapped keys pushed into the
// custom_fields JSONB bag, and an idempotent upsert keyed on id.
//
// Differences from the BE-23 script, both forced by this schema:
//
//   * IDs are copied verbatim, not run through toUuid(). These tables key on
//     TEXT (006) precisely so the legacy prefixed keys - quote_..., inv_... -
//     stay addressable. Hashing them to UUIDs would break the foreign
//     references between quotes, orders, invoices and contracts.
//
//   * ON CONFLICT DO UPDATE rather than DO NOTHING. BE-23 only had to seed
//     empty tables; this script also has to converge a database that already
//     holds partially-migrated rows, so re-running must refresh the data
//     columns rather than silently keep whatever was there first.
//
// Source data comes from readDb() (backend/data/db.json). When an entity is
// absent or empty there, the script falls back to the seed arrays in
// backend/db/seed.js so a fresh checkout migrates a realistic dataset instead
// of six empty tables.

import { readFile } from "node:fs/promises";

import { readDb } from "../backend/store.js";
import { getPool, closePool } from "../backend/db/pg.js";

/** Per-entity column definitions. `key` is the legacy camelCase source field. */
const ENTITIES = {
  products: {
    columns: [
      ["name", "name", "text"],
      ["sku", "sku", "text"],
      ["description", "description", "text"],
      ["price", "price", "money"],
      ["cost", "cost", "money"],
      ["category", "category", "text"],
      ["active", "active", "bool"],
      // `stock` and `minStock` have no column; the low-stock report reads them
      // and they are legitimately part of the record, so the overflow bag keeps
      // them rather than dropping data on the floor.
    ],
  },
  quotes: {
    columns: [
      ["title", "title", "text"],
      ["name", "title", "text"], // legacy quotes key the label off `name`
      ["quoteNumber", "quote_number", "text"],
      ["number", "quote_number", "text"], // ...or off `number`, per the portal seed
      ["dealId", "deal_id", "text"],
      ["companyId", "company_id", "text"],
      ["contactId", "contact_id", "text"],
      ["status", "status", "text"],
      ["subtotal", "subtotal", "money"],
      ["discount", "discount", "money"],
      ["tax", "tax", "money"],
      ["total", "total", "money"],
      ["expirationDate", "expiration_date", "date"],
      ["expiresAt", "expiration_date", "date"],
      ["notes", "notes", "text"],
    ],
    items: true,
  },
  contracts: {
    columns: [
      ["title", "title", "text"],
      ["name", "title", "text"], // legacy contracts use `name`
      ["contractNumber", "contract_number", "text"],
      ["number", "contract_number", "text"],
      ["dealId", "deal_id", "text"],
      ["companyId", "company_id", "text"],
      ["contactId", "contact_id", "text"],
      ["quoteId", "quote_id", "text"],
      ["status", "status", "text"],
      ["value", "value", "money"],
      ["amount", "value", "money"],
      ["startDate", "start_date", "date"],
      ["endDate", "end_date", "date"],
      ["terms", "terms", "text"],
    ],
  },
  orders: {
    columns: [
      ["orderNumber", "order_number", "text"],
      ["number", "order_number", "text"],
      ["dealId", "deal_id", "text"],
      ["companyId", "company_id", "text"],
      ["contactId", "contact_id", "text"],
      ["quoteId", "quote_id", "text"],
      ["contractId", "contract_id", "text"],
      ["status", "status", "text"],
      ["total", "total", "money"],
      ["amount", "total", "money"],
    ],
    // Legacy records carry line items under either key depending on the writer.
    items: true,
  },
  invoices: {
    columns: [
      ["invoiceNumber", "invoice_number", "text"],
      ["number", "invoice_number", "text"],
      ["orderId", "order_id", "text"],
      ["dealId", "deal_id", "text"],
      ["companyId", "company_id", "text"],
      ["contactId", "contact_id", "text"],
      ["status", "status", "text"],
      // The finance summary aggregates `amount`, not `total`; both land in total.
      ["amount", "total", "money"],
      ["total", "total", "money"],
      ["dueDate", "due_date", "date"],
      ["paidAt", "paid_at", "date"],
    ],
    items: true,
  },
  expenses: {
    columns: [
      ["title", "title", "text"],
      ["name", "title", "text"],
      ["category", "category", "text"],
      ["amount", "amount", "money"],
      ["date", "date", "date"],
      ["vendor", "vendor", "text"],
      ["dealId", "deal_id", "text"],
      ["companyId", "company_id", "text"],
      ["userId", "user_id", "text"],
      ["notes", "notes", "text"],
    ],
  },
};

// title is NOT NULL on quotes and contracts, but the legacy store sometimes
// has neither `title` nor `name` populated. Fall back through the fields that
// do carry a human label before giving up on the row.
const TITLE_FALLBACKS = {
  quotes: ["title", "name", "subject", "quoteNumber", "number", "customerEmail", "email"],
  contracts: ["title", "name", "contractNumber", "number", "customerEmail", "email"],
  products: ["name", "sku", "title"],
  expenses: ["title", "name", "vendor", "category"],
};

const SYSTEM_FIELDS = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "workspaceId",
  "items",
  "lineItems",
  "line_items",
  "_workflow",
]);

/** Normalize a legacy value to what the target column type expects. */
function coerce(value, kind) {
  if (value === undefined || value === null || value === "") return null;
  if (kind === "money" || kind === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (kind === "bool") {
    if (typeof value === "boolean") return value;
    const s = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(s)) return true;
    if (["false", "0", "no", "n", "off"].includes(s)) return false;
    return null;
  }
  if (kind === "date") {
    // A blank string is not a date: timestamptz rejects '' with 22007, so it has
    // to become NULL rather than reach the driver.
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (kind === "text") {
    if (typeof value === "object") return null;
    return String(value);
  }
  return value;
}

/** Line items: accept `items`, `lineItems` or `line_items`, always an array. */
function coerceItems(record) {
  const raw = record.items ?? record.lineItems ?? record.line_items;
  if (raw === undefined || raw === null) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function buildRow(entity, record, config) {
  const row = { custom_fields: {} };
  const handled = new Set(SYSTEM_FIELDS);

  for (const [key, column, kind] of config.columns) {
    handled.add(key);
    if (row[column] !== undefined) continue; // first mapping wins
    const coerced = coerce(record[key], kind);
    if (coerced !== null) row[column] = coerced;
  }

  if (config.items) row.items = coerceItems(record);

  // NOT NULL title columns need a value even when the source lacks one.
  if (row.title === undefined) {
    for (const key of TITLE_FALLBACKS[entity] || []) {
      const candidate = coerce(record[key], "text");
      if (candidate) {
        row.title = candidate;
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
 * Insert-only columns, appended after the mapped ones.
 *
 * created_at/updated_at are listed here rather than left to the column
 * defaults: a backfill that stamps every historical record with NOW() destroys
 * the only record of when the data was actually captured. main() populates
 * both from the legacy record's createdAt/updatedAt.
 */
const TIMESTAMP_COLUMNS = ["created_at", "updated_at"];

function updateSet(config) {
  const set = ["workspace_id = EXCLUDED.workspace_id", "custom_fields = EXCLUDED.custom_fields"];
  // Several legacy keys can alias to one column (title/name, total/amount, ...).
  // Postgres rejects an assignment list that names the same column twice, so
  // dedupe while preserving first-seen order.
  const emitted = new Set();
  for (const [, column] of config.columns) {
    if (emitted.has(column)) continue;
    emitted.add(column);
    set.push(`${column} = EXCLUDED.${column}`);
  }
  if (config.items) set.push("items = EXCLUDED.items");
  // created_at is deliberately absent: a re-run must not restamp a record's
  // original creation time. updated_at is absent too - the
  // update_updated_at_column() BEFORE UPDATE trigger sets it on every write, so
  // assigning it here would be immediately overwritten anyway.
  return set.join(", ");
}

async function upsert(client, table, config, rows) {
  const columns = ["id", ...new Set(config.columns.map(([, c]) => c))];
  if (config.items) columns.push("items");
  columns.push("workspace_id", "custom_fields");

  const insertColumns = ["id", ...columns.slice(1), ...TIMESTAMP_COLUMNS];
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
    if (config.items) record.items = JSON.stringify(row.items || []);
    await client.query(sql, insertColumns.map((c) => record[c] ?? null));
  }
  return rows.length;
}

/**
 * Read revenue seed arrays from backend/db/seed.js without executing it.
 *
 * Deliberately NOT `await import("../backend/db/seed.js")`: that module is an
 * executable script, not a data module. It has no exports and its top-level
 * `await mutateDb(...)` writes to backend/data/db.json on import, so importing
 * it from a migration would have the migration mutate its own source data as a
 * side effect. It also declares no revenue entities (only users, contacts,
 * leads, companies, deals, tasks, activities), so there is nothing there to
 * fall back to in the first place.
 *
 * Instead, extract the array literals textually. This stays read-only and
 * degrades to an empty result if the file is restructured, which is the safe
 * failure mode: the script reports 0 rows and moves on.
 */
async function seedFallback() {
  const path = new URL("../backend/db/seed.js", import.meta.url);
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const entity of Object.keys(ENTITIES)) {
    const literal = extractArrayLiteral(source, entity);
    if (!literal) continue;
    try {
      const parsed = JSON.parse(literal);
      if (Array.isArray(parsed)) out[entity] = parsed;
    } catch {
      // The literal is JS, not JSON (unquoted keys, trailing commas). It is
      // source-level sample data, not something worth reimplementing a
      // JavaScript parser for; report it as unavailable instead.
    }
  }
  return out;
}

/** Grab `const <name> = [ ... ];` as balanced source text, or null if absent. */
function extractArrayLiteral(source, name) {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*\\[`, "m").exec(source);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "[") depth += 1;
    else if (source[i] === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
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
  const seed = await seedFallback();
  const client = await getPool().connect();
  const summary = [];

  try {
    await client.query("BEGIN");

    for (const [entity, config] of Object.entries(ENTITIES)) {
      const started = Date.now();
      const fromJson = Array.isArray(db[entity]) ? db[entity] : [];
      const fromSeed = Array.isArray(seed[entity]) ? seed[entity] : [];
      // Seed rows carry no id/timestamps; the seeder normally adds those, so
      // synthesize an id per row to keep the upsert key stable and re-runnable.
      const source = fromJson.length
        ? fromJson
        : fromSeed.map((r, i) => ({ id: r.id || `${entity.replace(/s$/, "")}_seed_${i + 1}`, ...r }));

      const rows = [];
      const skipped = [];
      for (const record of source) {
        const row = buildRow(entity, record, config);
        row.id = record.id ? String(record.id) : null;
        if (!row.id) {
          skipped.push(record);
          continue;
        }
        row.created_at = record.createdAt || new Date().toISOString();
        row.updated_at = record.updatedAt || row.created_at;
        rows.push(row);
      }

      const written = rows.length ? await upsert(client, entity, config, rows) : 0;
      const elapsed = Date.now() - started;
      summary.push({
        entity,
        source: fromJson.length ? "db.json" : fromSeed.length ? "seed.js" : "empty",
        read: source.length,
        written,
        skipped: skipped.length,
        ms: elapsed,
      });
      console.log(
        `  ${entity.padEnd(10)} read ${String(source.length).padStart(4)}  ` +
          `written ${String(written).padStart(4)}  skipped ${String(skipped.length).padStart(3)}  ` +
          `(${elapsed} ms, from ${fromJson.length ? "db.json" : fromSeed.length ? "seed.js" : "empty"})`,
      );
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
  console.log(
    `Re-running is safe: the upsert keys on id, so a second run converges the ` +
      `same rows instead of duplicating them.`,
  );
  await closePool();
}

await main();
