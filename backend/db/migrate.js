import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../runtime.js";
import { closePool, getPool } from "./pg.js";

// Applied before any connection is opened. `getPool()` reads `process.env` at
// call time, so this makes a bare `node backend/db/migrate.js` work exactly
// like `npm run migrate` without any extra flags.
loadEnvFile();

const root = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(root, "migrations");

async function migrationFiles() {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

export async function runMigrations() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const appliedResult = await client.query(
      "SELECT filename FROM schema_migrations",
    );
    const applied = new Set(appliedResult.rows.map((row) => row.filename));

    for (const filename of await migrationFiles()) {
      if (applied.has(filename)) continue;

      const sql = await fs.readFile(path.join(migrationsDir, filename), "utf8");
      console.log(`[migrate] Applying ${filename}`);
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [filename],
      );
      console.log(`[migrate] Applied ${filename}`);
    }
  } finally {
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runMigrations();
    console.log("[migrate] Database is up to date");
  } catch (error) {
    console.error("[migrate] Migration failed:", error.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
