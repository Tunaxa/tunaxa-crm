import pg from "pg";
import { PG_DEFAULTS } from "../runtime.js";

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.PGHOST || PG_DEFAULTS.host,
      port: Number(process.env.PGPORT || PG_DEFAULTS.port),
      database: process.env.PGDATABASE || PG_DEFAULTS.database,
      user: process.env.PGUSER || PG_DEFAULTS.user,
      password: process.env.PGPASSWORD || PG_DEFAULTS.password,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on("error", (err) => {
      console.error("[pg] Unexpected pool error:", err.message);
    });
  }
  return pool;
}

export async function query(text, params) {
  const client = await getPool().connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
