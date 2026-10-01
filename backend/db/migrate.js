import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "./pg.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(root, "migrations");

const CREATE_SCHEMA_MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

/**
 * List migration files in application order. Lexicographic sorting guarantees
 * `001_*.sql`, `002_*.sql`, ... run in the intended sequence.
 */
async function listMigrationFiles() {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Remove top-level `BEGIN;`/`COMMIT;` wrappers from a migration file.
 *
 * The runner owns the transaction so a migration and its schema_migrations row
 * commit (or roll back) together. Older migrations still carry their own
 * `BEGIN;`/`COMMIT;` pair; executing those inside the runner's transaction
 * would commit it early and leave the tracking insert outside the transaction.
 *
 * Only standalone statement lines match, so PL/pgSQL `BEGIN` ... `END` blocks
 * inside function bodies (which have no terminating semicolon on the `BEGIN`
 * line) are untouched.
 *
 * @param {string} sql Raw migration file contents.
 * @returns {string} SQL with transaction-control statements neutralised.
 */
function stripTransactionControl(sql) {
  return sql.replace(
    /^[ \t]*(BEGIN|COMMIT)[ \t]*;[ \t]*$/gim,
    "-- $1 (stripped by runner)",
  );
}

/**
 * Apply every pending SQL migration in order. Idempotent and CI-friendly:
 *  - the `schema_migrations` tracking table is created when missing;
 *  - files already recorded are skipped (safe against an up-to-date DB);
 *  - each pending file plus its `schema_migrations` insert runs inside a single
 *    transaction, so a mid-file failure rolls the file back completely and
 *    re-running never re-applies partial state or hits duplicate-key rows;
 *  - top-level `BEGIN;`/`COMMIT;` wrappers inside legacy migration files are
 *    stripped first, so they cannot commit the runner's transaction early.
 *
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 *   Filenames applied in this run and those already present.
 */
export async function runMigrations() {
  const pool = getPool();
  const client = await pool.connect();
  const applied = [];
  const skipped = [];

  try {
    console.log("[migrate] Ensuring schema_migrations table exists");
    await client.query(CREATE_SCHEMA_MIGRATIONS_SQL);

    const appliedResult = await client.query(
      "SELECT filename FROM schema_migrations",
    );
    const appliedSet = new Set(appliedResult.rows.map((row) => row.filename));

    const files = await listMigrationFiles();

    for (const filename of files) {
      if (appliedSet.has(filename)) {
        skipped.push(filename);
        console.log(`[migrate] Skipping ${filename} (already applied)`);
        continue;
      }

      const sql = stripTransactionControl(
        await fs.readFile(path.join(migrationsDir, filename), "utf8"),
      );

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [filename],
        );
        await client.query("COMMIT");
        applied.push(filename);
        console.log(`[migrate] Applied ${filename}`);
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Connection may already be broken; preserve the original error.
        }
        error.message = `Migration ${filename} failed: ${error.message}`;
        throw error;
      }
    }

    return { applied, skipped };
  } finally {
    client.release();
  }
}

// CLI entry point: `npm run migrate` / `node backend/db/migrate.js`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { applied, skipped } = await runMigrations();
    console.log(
      `[migrate] Done: ${applied.length} applied, ${skipped.length} skipped`,
    );
    if (applied.length === 0) {
      console.log("[migrate] Database is already up to date");
    }
  } catch (error) {
    console.error(`[migrate] Migration failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
