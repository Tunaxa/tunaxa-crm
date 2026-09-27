import net from "node:net";
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from "./setup.js";

/**
 * checkOllamaStatus performs a real network call. It is mocked so the AI
 * verdicts are deterministic and the suite never depends on whether something
 * happens to be listening on 11434, while still passing through to the real
 * implementation by default.
 */
vi.mock("../services/ai.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, checkOllamaStatus: vi.fn(actual.checkOllamaStatus) };
});

/**
 * Wrapped rather than replaced so the route under test can be driven into its
 * 503 branch, which is otherwise unreachable: the connection pool is created
 * once and cached, so no environment variable can make a live database refuse
 * connections mid-process.
 */
vi.mock("../services/health.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDeepHealthStatus: vi.fn(actual.getDeepHealthStatus) };
});

/**
 * Mocked so the pool's failure modes can be provoked on demand. The real pool is
 * created once and cached for the process, so once any other test has connected,
 * no environment variable can make it refuse connections again.
 */
vi.mock("../db/pg.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getPool: vi.fn(actual.getPool) };
});

import { getDeepHealthStatus as spiedGetDeepHealthStatus } from "../services/health.js";
import { checkOllamaStatus } from "../services/ai.js";
import { getPool } from "../db/pg.js";
import { mutateDb } from "../store.js";
import { getRedisConnection as queueWorkflowRedisConnection } from "../services/workflowQueue.js";
import { getRedisConnection as queueTranscriptionRedisConnection } from "../services/transcriptionQueue.js";

const health = await vi.importActual("../services/health.js");
const actualPg = await vi.importActual("../db/pg.js");

let app;
let adminToken;
let memberToken;

const REDIS_ENV_KEYS = ["REDIS_URL", "REDIS_HOST", "REDIS_PORT", "REDIS_ENABLED"];
const AI_ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
const SMTP_ENV_KEYS = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"];

const savedEnv = {};
let fakeRedis = null;

function saveAndClearEnv(keys) {
  for (const key of keys) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv(keys) {
  for (const key of keys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

/**
 * A TCP server that answers a bare RESP PING with +PONG.
 *
 * The probe speaks raw RESP rather than using a client library, so this does not
 * have to emulate a handshake - it only has to reply like Redis does for PING.
 * That also lets the "redis is ok" path be asserted for real on a machine with
 * no Redis server installed.
 */
function startFakeRedis() {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", (chunk) => {
        if (/ping/i.test(chunk.toString("utf8"))) socket.write("+PONG\r\n");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(done);
          }),
      });
    });
  });
}

/** Mirrors the reachability probe in setup.js, so the PG assertions can skip cleanly. */
function canReachPostgres(timeoutMs = 300) {
  const host = process.env.PGHOST || "127.0.0.1";
  const port = Number(process.env.PGPORT || 5432);
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (reachable) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

beforeAll(async () => {
  saveAndClearEnv(REDIS_ENV_KEYS);
  saveAndClearEnv(AI_ENV_KEYS);
  saveAndClearEnv(SMTP_ENV_KEYS);

  // The store must be pointed at the test database before the app is imported,
  // otherwise server.js binds to the real data file.
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;

  await seedTestUser();
  adminToken = await loginAs(app);

  // A second account with a non-admin role, to prove the endpoint is not merely
  // checking for any valid session.
  await mutateDb((db) => {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync("secret123", salt, 64).toString("hex");
    db.users.push({
      id: "usr_member",
      name: "Member User",
      email: "member@test.com",
      password: `${salt}:${hash}`,
      role: "member",
      createdAt: new Date().toISOString(),
    });
  });
  const memberLogin = await request(app).post("/api/auth/login").send({
    email: "member@test.com",
    password: "secret123",
  });
  expect(memberLogin.status).toBe(200);
  memberToken = memberLogin.body.token;

  fakeRedis = await startFakeRedis();
});

afterAll(async () => {
  if (fakeRedis) await fakeRedis.close();
  restoreEnv([...REDIS_ENV_KEYS, ...AI_ENV_KEYS, ...SMTP_ENV_KEYS]);
  await cleanupTestDb();
});

beforeEach(() => {
  // Re-assert the pass-through: a mockImplementationOnce or mockReturnValueOnce
  // from a previous test must not leak into the next one.
  spiedGetDeepHealthStatus.mockImplementation(health.getDeepHealthStatus);
  getPool.mockImplementation(actualPg.getPool);
  checkOllamaStatus.mockImplementation(async () => ({ online: false, models: [], url: "http://localhost:11434" }));
});

describe("GET /api/health/deep - authentication and RBAC", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await request(app).get("/api/health/deep");
    expect(res.status).toBe(401);
  });

  it("rejects a member-role token with 403", async () => {
    const res = await request(app)
      .get("/api/health/deep")
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(403);
  });

  it("allows an admin token with 200 and a full report", async () => {
    const res = await request(app)
      .get("/api/health/deep")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/^(ok|degraded)$/);
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof res.body.uptime).toBe("number");
    expect(res.body.subsystems).toBeTruthy();
    for (const key of ["postgres", "redis", "smtp", "ai"]) {
      expect(res.body.subsystems[key]).toBeTypeOf("string");
      // Flattened mirror of the nested map.
      expect(res.body[key]).toBe(res.body.subsystems[key]);
    }
  });

  it("answers 503 with the report when postgres is unreachable", async () => {
    spiedGetDeepHealthStatus.mockImplementationOnce(async () => ({
      status: "error",
      timestamp: new Date().toISOString(),
      uptime: 1,
      subsystems: { postgres: "error", redis: "degraded", smtp: "unconfigured", ai: "offline" },
      postgres: "error",
      redis: "degraded",
      smtp: "unconfigured",
      ai: "offline",
    }));

    const res = await request(app)
      .get("/api/health/deep")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(503);
    expect(res.body.postgres).toBe("error");
  });

  it("keeps the public liveness probe open and unauthenticated", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("postgres probe", () => {
  it("returns ok against a live database", async () => {
    if (!(await canReachPostgres())) {
      return; // No server listening; nothing to assert about a live connection.
    }
    await expect(health.checkPostgresHealth()).resolves.toBe("ok");
  });

  it("returns error when the pool rejects the probe", async () => {
    getPool.mockReturnValueOnce({
      query: async () => {
        throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      },
    });
    await expect(health.checkPostgresHealth()).resolves.toBe("error");
  });

  it("returns error rather than hanging when the probe never settles", async () => {
    getPool.mockReturnValueOnce({ query: () => new Promise(() => {}) });
    // A pool that accepts the call and then goes silent is the case a health
    // endpoint most needs to survive, since it would otherwise hold the request
    // open until the client gave up.
    await expect(health.checkPostgresHealth({ timeoutMs: 60 })).resolves.toBe("error");
  });
});

describe("redis probe", () => {
  it("returns degraded when redis is not configured", async () => {
    await expect(health.checkRedisHealth({ env: {} })).resolves.toBe("degraded");
  });

  it("returns degraded when REDIS_ENABLED is explicitly false", async () => {
    await expect(health.checkRedisHealth({ env: { REDIS_ENABLED: "false", REDIS_URL: "redis://127.0.0.1:1" } })).resolves.toBe(
      "degraded",
    );
  });

  it("returns degraded when redis is configured but unreachable", async () => {
    // Port 1 is reserved and never listening.
    await expect(health.checkRedisHealth({ env: { REDIS_URL: "redis://127.0.0.1:1" }, timeoutMs: 1000 })).resolves.toBe(
      "degraded",
    );
  });

  it("returns ok when redis answers a ping", async () => {
    await expect(
      health.checkRedisHealth({ env: { REDIS_URL: `redis://127.0.0.1:${fakeRedis.port}` }, timeoutMs: 2000 }),
    ).resolves.toBe("ok");
  });

  it("agrees with both queue services on how a redis connection is resolved", () => {
    const cases = [
      {},
      { REDIS_URL: "redis://example:6379" },
      { REDIS_HOST: "10.0.0.5" },
      { REDIS_PORT: "6380" },
      { REDIS_HOST: "10.0.0.5", REDIS_PORT: "6381" },
      { REDIS_ENABLED: "true" },
      { REDIS_URL: "redis://example:6379", REDIS_ENABLED: "true" },
    ];
    const previous = {};
    for (const key of REDIS_ENV_KEYS) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
    try {
      for (const env of cases) {
        for (const key of REDIS_ENV_KEYS) delete process.env[key];
        Object.assign(process.env, env);
        expect(health.resolveRedisConnection(process.env)).toEqual(queueWorkflowRedisConnection());
        expect(health.resolveRedisConnection(process.env)).toEqual(queueTranscriptionRedisConnection());
      }
    } finally {
      for (const key of REDIS_ENV_KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});

describe("smtp probe", () => {
  afterEach(async () => {
    await mutateDb((db) => {
      db.settings = { smtpHost: "", smtpUser: "", smtpPass: "" };
    });
  });

  it("returns unconfigured when no mail settings exist", async () => {
    await mutateDb((db) => {
      db.settings = { smtpHost: "", smtpUser: "", smtpPass: "" };
    });
    await expect(health.checkSmtpHealth()).resolves.toBe("unconfigured");
  });

  it("returns ok when an smtp host and user are stored", async () => {
    await mutateDb((db) => {
      db.settings = { smtpHost: "smtp.example.com", smtpUser: "mailer", smtpPass: "pw" };
    });
    await expect(health.checkSmtpHealth()).resolves.toBe("ok");
  });

  it("returns ok when a provider api key is stored", async () => {
    await mutateDb((db) => {
      db.settings = { emailProvider: "resend", resendApiKey: "re_test" };
    });
    await expect(health.checkSmtpHealth()).resolves.toBe("ok");
  });

  it("returns ok when smtp credentials come from the environment", async () => {
    process.env.SMTP_HOST = "smtp.env.example.com";
    process.env.SMTP_USER = "env-mailer";
    await expect(health.checkSmtpHealth()).resolves.toBe("ok");
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
  });
});

describe("ai probe", () => {
  it("returns offline when no provider is configured and the local runtime is down", async () => {
    await expect(health.checkAiHealth({ env: {} })).resolves.toBe("offline");
  });

  it("returns ok when a hosted provider key is present", async () => {
    await expect(health.checkAiHealth({ env: { OPENAI_API_KEY: "sk-test" } })).resolves.toBe("ok");
    await expect(health.checkAiHealth({ env: { ANTHROPIC_API_KEY: "sk-ant-test" } })).resolves.toBe("ok");
  });

  it("returns ok when the local runtime reports itself online", async () => {
    checkOllamaStatus.mockImplementationOnce(async () => ({ online: true, models: ["gemma3:4b"] }));
    await expect(health.checkAiHealth({ env: {} })).resolves.toBe("ok");
  });

  it("does not rely on isAiConfigured, which is always true", async () => {
    // DEFAULT_SETTINGS seeds ollamaBaseUrl, so the settings-level helper would
    // report "configured" for an installation with no AI runtime at all.
    const { isAiConfigured } = await import("../services/config.js");
    const { getSettings } = await import("../services/config.js");
    expect(isAiConfigured(await getSettings())).toBe(true);
    await expect(health.checkAiHealth({ env: {} })).resolves.toBe("offline");
  });
});

describe("composite report", () => {
  const probes = (values) => ({
    postgres: async () => values.postgres,
    redis: async () => values.redis,
    smtp: async () => values.smtp,
    ai: async () => values.ai,
  });

  it("reports ok only when every subsystem is at its best", async () => {
    const report = await health.getDeepHealthStatus({
      probes: probes({ postgres: "ok", redis: "ok", smtp: "ok", ai: "ok" }),
    });
    expect(report.status).toBe("ok");
  });

  it("reports degraded when a secondary subsystem is down but postgres is fine", async () => {
    const report = await health.getDeepHealthStatus({
      probes: probes({ postgres: "ok", redis: "degraded", smtp: "unconfigured", ai: "offline" }),
    });
    expect(report.status).toBe("degraded");
  });

  it("reports error when postgres is down regardless of the others", async () => {
    const report = await health.getDeepHealthStatus({
      probes: probes({ postgres: "error", redis: "ok", smtp: "ok", ai: "ok" }),
    });
    expect(report.status).toBe("error");
  });

  it("isolates a throwing probe to its own subsystem", async () => {
    const report = await health.getDeepHealthStatus({
      probes: {
        postgres: async () => "ok",
        redis: async () => {
          throw new Error("redis exploded");
        },
        smtp: async () => "ok",
        ai: async () => "ok",
      },
    });
    expect(report.status).toBe("degraded");
    expect(report.redis).toBe("degraded");
    expect(report.postgres).toBe("ok");
  });

  it("exposes each status both nested and flattened", async () => {
    const report = await health.getDeepHealthStatus({
      probes: probes({ postgres: "ok", redis: "degraded", smtp: "unconfigured", ai: "offline" }),
    });
    expect(report.subsystems).toEqual({
      postgres: "ok",
      redis: "degraded",
      smtp: "unconfigured",
      ai: "offline",
    });
    for (const [key, value] of Object.entries(report.subsystems)) {
      expect(report[key]).toBe(value);
    }
  });
});
