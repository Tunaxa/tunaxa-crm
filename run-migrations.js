// Applies every SQL file in backend/db/migrations in numeric order, using
// node-postgres so no psql or Docker is required.
//
//   node run-migrations.js
//
// Safe to re-run: every migration is written with IF NOT EXISTS / OR REPLACE,
// so applying an already-applied set is a no-op.
//
// 004 reuses update_updated_at_column() from 001, so order matters - the files
// are sorted by their numeric prefix rather than by glob order.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, query } from "./backend/db/pg.js";

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "backend",
  "db",
  "migrations",
);

function connectionTarget() {
  const {
    PGHOST = "127.0.0.1",
    PGPORT = "5432",
    PGDATABASE = "tunaxa",
    PGUSER = "postgres",
  } = process.env;
  return `${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}`;
}

async function migrate() {
  const entries = await fs.readdir(migrationsDir);
  const files = entries
    .filter((name) => name.endsWith(".sql"))
    // Numeric collation so 010_ sorts after 009_, not before it.
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

  if (files.length === 0) {
    throw new Error(`No .sql migrations found in ${migrationsDir}`);
  }

  console.log(`Target: ${connectionTarget()}`);
  console.log(`Applying ${files.length} migration(s) from ${migrationsDir}\n`);

  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    const statements = sql.split(";").length - 1;
    process.stdout.write(`  ${file} `);
    // Sent as one parameterless query, so node-postgres uses the simple query
    // protocol and Postgres executes the whole file - including the $$ bodies
    // in 001 - in a single implicit transaction. A failure anywhere rolls the
    // entire file back rather than leaving it half-applied.
    await query(sql);
    console.log(`ok (${statements} statements)`);
  }

  console.log("\nAll migrations applied successfully.");
}

try {
  await migrate();
} catch (error) {
  // Postgres reports the actionable detail in `code` (e.g. 42P01 undefined_table,
  // 42703 undefined_column); `message` alone is often just the statement.
  console.error(`\nMigration failed [${error.code || "no code"}]: ${error.message}`);
  if (error.position) console.error(`  at statement position ${error.position}`);
  if (/ECONNREFUSED/.test(error.message)) {
    console.error(
      "\nNothing is listening on that host/port. Check that PostgreSQL is running,\n" +
        "or override the target with PGHOST / PGPORT / PGDATABASE / PGUSER.",
    );
  }
  await getPool().end().catch(() => {});
  process.exit(1);
}

// Release the pool so the process can exit on its own instead of hanging on an
// open connection.
await getPool().end();
