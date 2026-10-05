import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setDbPath } from "../store.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDbDir = path.join(root, "__tests__");
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

// null = not probed yet; true/false = cached for the life of this test file.
let pgReachable = null;

// A bare TCP connect settles in milliseconds. Calling query() directly instead
// costs the pool's full 5s connectionTimeoutMillis every time the server is
// down, once per test file.
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
