import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(root, relative));

const README = read("README.md");
const RUNTIME = read("backend/runtime.js");
const PG = read("backend/db/pg.js");
const ENV_EXAMPLE = exists(".env.example") ? read(".env.example") : "";

// Files that must derive the API location instead of hardcoding a port.
const PORT_SENSITIVE = [
  "backend/server.js",
  "backend/routes/messages.js",
  "backend/routes/webhookendpoints.js",
  "start.js",
  "web/vite.config.ts",
  "web/src/App.tsx",
  ".devcontainer/devcontainer.json",
];

const ENV_KEYS = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "REDIS_URL",
  "REDIS_ENABLED",
  "PORT",
  "HOST",
  "BASE_URL",
  "API_HEALTH_URL",
  "NODE_ENV",
  "SENTRY_DSN",
];

afterEach(() => {
  vi.resetModules();
  delete process.env.PORT;
  delete process.env.HOST;
  delete process.env.BASE_URL;
});

async function loadRuntime() {
  vi.resetModules();
  return import("../runtime.js");
}

describe("Runtime configuration defaults", () => {
  it("defaults the API to 127.0.0.1:3001", async () => {
    const { getHost, getPort, DEFAULT_PORT, DEFAULT_HOST } = await loadRuntime();
    expect(DEFAULT_PORT).toBe(3001);
    expect(DEFAULT_HOST).toBe("127.0.0.1");
    expect(getHost()).toBe("127.0.0.1");
    expect(getPort()).toBe(3001);
  });

  it("honours PORT and HOST from the environment", async () => {
    process.env.PORT = "4321";
    process.env.HOST = "0.0.0.0";
    const { getHost, getPort } = await loadRuntime();
    expect(getPort()).toBe(4321);
    expect(getHost()).toBe("0.0.0.0");
  });

  it("falls back to the default when PORT is not a usable port number", async () => {
    const { getPort } = await loadRuntime();

    for (const invalid of ["not-a-port", "0", "70000", "-1", ""]) {
      process.env.PORT = invalid;
      expect(getPort()).toBe(3001);
    }
  });

  it("derives the API base URL from PORT and HOST", async () => {
    process.env.PORT = "4321";
    const { getApiBaseUrl } = await loadRuntime();
    expect(getApiBaseUrl()).toBe("http://127.0.0.1:4321");
  });

  it("lets BASE_URL win over the derived origin and strips trailing slashes", async () => {
    process.env.BASE_URL = "https://crm.example.com/";
    const { getApiBaseUrl } = await loadRuntime();
    expect(getApiBaseUrl()).toBe("https://crm.example.com");
  });

  it("reads configuration lazily so a .env loaded later is still picked up", async () => {
    const { getPort } = await loadRuntime();
    expect(getPort()).toBe(3001);
    process.env.PORT = "5555";
    expect(getPort()).toBe(5555);
  });
});

describe("PostgreSQL configuration", () => {
  it("keeps a single set of connection defaults", async () => {
    const { PG_DEFAULTS } = await loadRuntime();
    expect(PG_DEFAULTS).toEqual({
      host: "127.0.0.1",
      port: 5432,
      database: "tunaxa",
      user: "postgres",
      password: "tunaxa2024",
    });
  });

  it("reads every setting from PG* variables with the shared defaults as fallback", async () => {
    for (const variable of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]) {
      expect(PG).toContain(`process.env.${variable} ||`);
    }
    // No second naming convention.
    expect(PG).not.toContain("DATABASE_URL");
    expect(RUNTIME).toContain("DATABASE_URL");
  });
});

describe("Documentation matches the code", () => {
  it("documents the same API port the code defaults to", () => {
    expect(README).toContain("`3001`");
    expect(README).toContain("http://127.0.0.1:3001");
    expect(README).not.toContain("127.0.0.1:3000");
  });

  it("documents the same PostgreSQL password default as pg.js", () => {
    expect(README).toContain("`tunaxa2024`");
    expect(README).not.toMatch(/\|\s*`PGPASSWORD`\s*\|\s*`password`\s*\|/);
  });

  it("documents the same frontend port the dev script uses", () => {
    expect(README).toContain("`5173`");
  });

  it("points at backend/runtime.js as the single source of truth", () => {
    expect(README).toContain("backend/runtime.js");
  });

  it("documents the scratch setup in order, including env and migrations", () => {
    const workflow = README.slice(README.indexOf("## Development workflow"));
    const order = [
      "npm install",
      "cp .env.example .env",
      "npm run migrate",
      "npm start",
    ].map(step => workflow.indexOf(step));

    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("does not advertise an unsupported Node version", () => {
    expect(README).not.toMatch(/Node\.js 18/);
    expect(README).toMatch(/Node\.js 20\.12/);
  });
});

describe("No hardcoded API ports outside the config module", () => {
  it.each(PORT_SENSITIVE)("%s does not hardcode port 3000", (file) => {
    expect(read(file)).not.toContain(":3000");
  });

  it("backend/server.js binds the configured port", () => {
    const server = read("backend/server.js");
    expect(server).toContain("getPort()");
    expect(server).toContain("getHost()");
    expect(server).not.toContain("app.listen(3001");
  });

  it("web/src/App.tsx builds public URLs from the current origin", () => {
    expect(read("web/src/App.tsx")).toContain("window.location.origin");
  });
});

describe("Environment template", () => {
  it("exists and documents the same defaults as the code", () => {
    expect(ENV_EXAMPLE).toContain("PGPASSWORD=tunaxa2024");
    expect(ENV_EXAMPLE).toContain("#PORT=3001");
  });

  it("only mentions variables the application actually reads", () => {
    const declared = [...ENV_EXAMPLE.matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1]);
    for (const key of declared) {
      expect(ENV_KEYS).toContain(key);
    }
  });

  it("warns that DATABASE_URL is not supported", () => {
    expect(ENV_EXAMPLE).toMatch(/`?DATABASE_URL`?[\s\S]{0,80}?NOT read/i);
  });

  it("is git-ignored by its real counterpart only, not the template", () => {
    const gitignore = read(".gitignore");
    expect(gitignore.split(/\r?\n/).map(line => line.trim())).toContain(".env");
    expect(gitignore).not.toMatch(/^\.env\.example$/m);
  });
});