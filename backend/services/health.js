import net from "node:net";
import { getPool } from "../db/pg.js";
import { getSettings, isEmailConfigured } from "./config.js";
import { checkOllamaStatus } from "./ai.js";

/**
 * Deep subsystem health checks.
 *
 * Everything here is deliberately dependency-light. A health endpoint that
 * imports half the application inherits half the application's failure modes:
 * if the queues or the AI service cannot even be loaded, the thing you reach
 * for to find out why is the thing that is down. So this module talks to the
 * subsystems directly instead of going through the services that wrap them.
 *
 * Every probe is bounded by a timeout and is expected to return a status string
 * rather than throw, so one dead subsystem can never hang or fail the report.
 */

export const PROBE_TIMEOUT_MS = 2000;

export const PROBE_STATUS = {
  postgres: { ok: "ok", bad: "error" },
  redis: { ok: "ok", bad: "degraded" },
  smtp: { ok: "ok", bad: "unconfigured" },
  ai: { ok: "ok", bad: "offline" },
};

/**
 * Races a promise against a timeout, and clears the timer either way so a
 * pending probe never keeps the event loop alive. The losing promise is left to
 * settle on its own; every caller already handles rejection, so an orphan
 * rejection here is contained rather than propagated.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} probe timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Resolves the Redis connection the same way the queue services do.
 *
 * This mirrors getRedisConnection() in services/workflowQueue.js and
 * services/transcriptionQueue.js rather than importing it, because either
 * import pulls BullMQ, the workflow engine, the AI service and the SSE hub into
 * the health path. The duplication is guarded by a test that asserts this
 * function and the queue modules agree for every REDIS_* combination.
 */
export function resolveRedisConnection(env = process.env) {
  if (env.REDIS_URL) return { url: env.REDIS_URL };
  if (env.REDIS_HOST || env.REDIS_PORT) {
    return {
      host: env.REDIS_HOST || "127.0.0.1",
      port: Number(env.REDIS_PORT) || 6379,
    };
  }
  if (env.REDIS_ENABLED === "true") {
    return { url: "redis://127.0.0.1:6380" };
  }
  return null;
}

/**
 * PostgreSQL is the one hard dependency: without it the CRM cannot serve data.
 * So it is the only probe whose failure is fatal, and the only one allowed to
 * answer "error" rather than a softer degraded state.
 */
export async function checkPostgresHealth({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    await withTimeout(getPool().query("SELECT 1 AS alive;"), timeoutMs, "postgres");
    return PROBE_STATUS.postgres.ok;
  } catch {
    return PROBE_STATUS.postgres.bad;
  }
}

/**
 * Translates the connection shapes the queue services produce into host/port.
 *
 * Note that ioredis is deliberately not used here. It only accepts a host/port
 * (or a connection string as its first positional argument) and silently ignores
 * a `url` key, which is exactly the shape `getRedisConnection()` returns for
 * REDIS_URL. It also opens with a RESP3 `HELLO 3` handshake, so a health probe
 * would have to complete a full client negotiation - and hold a reconnecting
 * client - to ask one question. A bare RESP PING answers the same question
 * against a plain socket, and a real Redis replies +PONG to it without caring
 * which protocol version the caller would have preferred.
 */
function toRedisTarget(connection) {
  if (connection.url) {
    try {
      const url = new URL(connection.url);
      return { host: url.hostname || "127.0.0.1", port: Number(url.port) || 6379 };
    } catch {
      return null;
    }
  }
  return { host: connection.host || "127.0.0.1", port: Number(connection.port) || 6379 };
}

function pingRedis(connection, timeoutMs) {
  const target = toRedisTarget(connection);
  if (!target) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let received = "";
    // Overall deadline, independent of socket inactivity: a server that accepts
    // the connection and then says nothing must still resolve.
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const finish = (alive) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };

    const socket = net.connect({ host: target.host, port: target.port });
    socket.on("connect", () => socket.write("*1\r\n$4\r\nPING\r\n"));
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (received.includes("+PONG")) finish(true);
      // An auth or ACL rejection still proves Redis is listening; it is just not
      // usable by the queues, which is still a degraded state.
      else if (/-NOAUTH|-ERR|-WRONGPASS|-DENIED|-LOADING/.test(received)) finish(false);
    });
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

/**
 * Redis is optional infrastructure: the queues degrade to in-process fallback
 * queues when it is absent, which is a supported mode rather than an outage.
 * That is why an unreachable or unconfigured Redis reports "degraded" and not
 * "error" - callers should not page anyone for it.
 */
export async function checkRedisHealth({ timeoutMs = PROBE_TIMEOUT_MS, env = process.env } = {}) {
  try {
    if (env.REDIS_ENABLED === "false") return PROBE_STATUS.redis.bad;
    const connection = resolveRedisConnection(env);
    if (!connection) return PROBE_STATUS.redis.bad;
    const alive = await pingRedis(connection, timeoutMs);
    return alive ? PROBE_STATUS.redis.ok : PROBE_STATUS.redis.bad;
  } catch {
    return PROBE_STATUS.redis.bad;
  }
}

/**
 * SMTP answers "is it configured", not "does it accept mail today". A live
 * transport handshake inside a health endpoint would add a multi-second network
 * dependency to a diagnostic call, and repeatedly authenticating against a
 * provider invites account lockouts. Deliverability is observable through the
 * send path; configuration is what this probe reports.
 */
export async function checkSmtpHealth() {
  const settings = await getSettings();
  // Mirrors isEmailConfigured()'s host+user requirement, and additionally
  // honours SMTP_* environment variables for deployments that inject mail
  // credentials outside the CRM settings store.
  const envConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);
  const configured = isEmailConfigured(settings) || envConfigured;
  return configured ? PROBE_STATUS.smtp.ok : PROBE_STATUS.smtp.bad;
}

/**
 * Deliberately does not use isAiConfigured() from services/config.js. That helper
 * is `Boolean(settings.ollamaBaseUrl)`, and DEFAULT_SETTINGS seeds that to
 * "http://localhost:11434", so it is true for every installation - including
 * ones with no AI runtime at all. Reporting "ok" from it would make this probe
 * meaningless.
 *
 * A provider key is treated as ready without a network call, because verifying a
 * hosted model would mean spending tokens on every dashboard refresh. The local
 * runtime is probed for real, since that endpoint is free to ask.
 */
export async function checkAiHealth({ timeoutMs = PROBE_TIMEOUT_MS, env = process.env } = {}) {
  try {
    if (env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY) return PROBE_STATUS.ai.ok;
    const settings = await getSettings();
    const status = await withTimeout(checkOllamaStatus(settings), timeoutMs, "ai");
    return status && status.online ? PROBE_STATUS.ai.ok : PROBE_STATUS.ai.bad;
  } catch {
    return PROBE_STATUS.ai.bad;
  }
}

const defaultProbes = {
  postgres: checkPostgresHealth,
  redis: checkRedisHealth,
  smtp: checkSmtpHealth,
  ai: checkAiHealth,
};

/**
 * Runs all four probes concurrently and normalizes the result.
 *
 * Probes are injectable so the report can be exercised against failure modes
 * that are impractical to produce for real - an unreachable database in
 * particular cannot be simulated by environment variables alone, because the
 * connection pool is created once and cached for the process.
 *
 * The payload carries the statuses twice: nested under `subsystems` for
 * readability, and flattened for callers that want to read a single field
 * without a lookup.
 */
export async function getDeepHealthStatus({ timeoutMs = PROBE_TIMEOUT_MS, probes } = {}) {
  const run = probes || defaultProbes;
  const [postgres, redis, smtp, ai] = await Promise.allSettled([
    run.postgres({ timeoutMs }),
    run.redis({ timeoutMs }),
    run.smtp({ timeoutMs }),
    run.ai({ timeoutMs }),
  ]);

  const value = (settled, bad) => (settled.status === "fulfilled" ? settled.value : bad);
  const subsystems = {
    postgres: value(postgres, PROBE_STATUS.postgres.bad),
    redis: value(redis, PROBE_STATUS.redis.bad),
    smtp: value(smtp, PROBE_STATUS.smtp.bad),
    ai: value(ai, PROBE_STATUS.ai.bad),
  };

  // Postgres down means the CRM cannot function, so it is an error regardless of
  // the other three. Postgres up with any secondary subsystem unhappy is still
  // serving traffic, so it is reported as degraded rather than error.
  const secondaryHealthy =
    subsystems.redis === PROBE_STATUS.redis.ok &&
    subsystems.smtp === PROBE_STATUS.smtp.ok &&
    subsystems.ai === PROBE_STATUS.ai.ok;
  const status =
    subsystems.postgres !== PROBE_STATUS.postgres.ok
      ? "error"
      : secondaryHealthy
        ? "ok"
        : "degraded";

  return {
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    subsystems,
    ...subsystems,
  };
}
