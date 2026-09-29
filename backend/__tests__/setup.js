import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { beforeAll } from "vitest";
import { setDbPath } from "../store.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Run the SQL migrations before the suite starts. We invoke node directly via
// process.execPath instead of `npm run migrate` so the harness never has to
// spawn the platform-specific npm.cmd/npm wrapper — spawning .cmd shims without
// a shell throws EINVAL on Windows with Node >= 22. Direct node spawns are
// shell-free and identical on every platform.
const migrateScript = path.join(repoRoot, "backend", "db", "migrate.js");

beforeAll(async () => {
  await execFileAsync(process.execPath, [migrateScript], {
    cwd: repoRoot,
    env: process.env,
  });
});

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDbDir = path.join(root, "__tests__");
// Worker-specific DB path: VITEST_POOL_ID is unique per Vitest worker, so
// concurrent/sequential test files never share a JSON file handle. Fall back to
// "1" when run outside Vitest (e.g., the migrate step or a one-off script).
const workerId = (process.env.VITEST_POOL_ID || "1").replace(
  /[^a-zA-Z0-9_-]/g,
  "_",
);
const testDbFile = path.join(testDbDir, `test-db-${workerId}.json`);

const emptyDb = {
  users: [],
  sessions: [],
  leads: [],
  contacts: [],
  companies: [],
  deals: [],
  tasks: [],
  activities: [],
  workflows: [],
  calls: [],
  recordings: [],
  messages: [],
  sequences: [],
  team: [],
  customFields: [],
  audit: [],
  lists: [],
  tickets: [],
  articles: [],
  revisions: [],
  webVisits: [],
  chatConversations: [],
  meetingLinks: [],
  leadScoringRules: [],
  stageGates: {},
  forms: [],
  executionQueue: [],
  campaigns: [],
  emailLists: [],
  landingPages: [],
  products: [],
  orders: [],
  invoices: [],
  expenses: [],
  employees: [],
  leaveRequests: [],
  attendance: [],
  quotes: [],
  contracts: [],
  marketingEmails: [],
  marketingEvents: [],
  goals: [],
  surveys: [],
  surveyResponses: [],
  webhookEndpoints: [],
  webhookDeliveries: [],
  settings: {},
  meta: { seedVersion: 0 },
};

export async function resetTestDb() {
  await fs.mkdir(testDbDir, { recursive: true });
  await fs.writeFile(testDbFile, JSON.stringify(emptyDb, null, 2));
  setDbPath(testDbFile);
}

export async function cleanupTestDb() {
  try {
    await fs.unlink(testDbFile);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
}

export async function seedTestUser() {
  const { mutateDb } = await import("../store.js");
  const crypto = await import("node:crypto");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("test123", salt, 64).toString("hex");
  const password = `${salt}:${hash}`;
  const now = new Date().toISOString();

  await mutateDb((db) => {
    const user = {
      id: "usr_test",
      name: "Test User",
      email: "test@test.com",
      password,
      role: "Owner",
      createdAt: now,
    };
    db.users.push(user);
    db.team.push({
      id: "team_test",
      name: user.name,
      email: user.email,
      role: "Owner",
      status: "Active",
      createdAt: now,
    });
  });
}

import supertest from "supertest";

export async function loginAs(app) {
  const res = await supertest(app)
    .post("/api/auth/login")
    .send({ email: "test@test.com", password: "test123" });
  return res.body.token;
}
