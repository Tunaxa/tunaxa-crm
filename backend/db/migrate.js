import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, closePool } from "./pg.js";

const directory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

const migrationFiles = (await fs.readdir(directory))
  .filter((file) => file.endsWith(".sql"))
  .sort();

try {
  for (const file of migrationFiles) {
    const sql = await fs.readFile(path.join(directory, file), "utf8");
    await query(sql);
    console.log(`Applied ${file}`);
  }
} finally {
  await closePool();
}