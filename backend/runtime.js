import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.dirname(fileURLToPath(import.meta.url));

// `.env` lives at the repository root, next to `.env.example`.
export const ENV_FILE = path.join(backendRoot, "..", ".env");

export const DEFAULT_PORT = 3001;
export const DEFAULT_HOST = "127.0.0.1";

/**
 * Loads the repository `.env` into `process.env` when present.
 *
 * Values already present in the real environment always win, so a shell export
 * or a CI secret overrides the file. Returns true when the file was applied.
 *
 * Called explicitly from each entry point (server, launcher, migrate CLI)
 * rather than on import, so importing config has no side effect. The accessors
 * below read `process.env` lazily, which is what makes that ordering safe.
 */
export function loadEnvFile(file = ENV_FILE) {
  if (!fs.existsSync(file)) return false;
  try {
    process.loadEnvFile(file);
    return true;
  } catch (error) {
    console.warn(`[config] Ignoring unreadable ${path.basename(file)}: ${error.message}`);
    return false;
  }
}

function readPort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(`[config] Ignoring invalid PORT="${raw}", using ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  return parsed;
}

export function getHost() {
  return process.env.HOST || DEFAULT_HOST;
}

export function getPort() {
  return readPort(process.env.PORT);
}

/**
 * Absolute origin the API is reachable at, for URLs handed to third parties
 * (webhook targets, email tracking pixels). `BASE_URL` wins when set, because
 * a reverse proxy may expose the API somewhere the process cannot see.
 */
export function getApiBaseUrl() {
  const explicit = String(process.env.BASE_URL || "").replace(/\/+$/, "");
  return explicit || `http://${getHost()}:${getPort()}`;
}

/**
 * PostgreSQL connection defaults, overridden per-value by the standard `PG*`
 * libpq variables. Those are the only database variable names this project
 * reads - `DATABASE_URL` and `DB_*` are deliberately not supported.
 */
export const PG_DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 5432,
  database: "tunaxa",
  user: "postgres",
  password: "tunaxa2024",
});