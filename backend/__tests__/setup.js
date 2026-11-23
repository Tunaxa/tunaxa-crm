import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setDbPath, EMPTY_DB } from "../store.js";
import { query } from "../db/pg.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDbDir = path.join(root, "__tests__");
const workerId = (process.env.VITEST_POOL_ID || "1").replace(
  /[^a-zA-Z0-9_-]/g,
  "_",
);
const testDbFile = path.join(testDbDir, `test-db-${workerId}.json`);

let pgReachable = null;

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
  const seeded = { ...EMPTY_DB, sequenceEnrollments: [] };
  await fs.writeFile(testDbFile, JSON.stringify(seeded, null, 2));
  setDbPath(testDbFile);
  if (pgReachable === false) return;
  if (pgReachable === null) {
    pgReachable = await canReachPostgres();
    if (pgReachable === false) return;
  }
  try {
    await query(
      "TRUNCATE TABLE activities, tasks, deals, companies, leads, contacts, products, quotes, contracts, orders, invoices, expenses, campaigns, email_lists, forms, tickets, surveys, survey_responses, workflow_runs, goals CASCADE;",
    );
    pgReachable = true;
    try {
      await query("TRUNCATE TABLE saved_reports CASCADE;");
    } catch (error) {
      if (error.code !== "42P01") throw error;
    }
    try {
      await query("TRUNCATE TABLE pipeline_definitions CASCADE;");
    } catch (error) {
      if (error.code !== "42P01") throw error;
    }
  } catch (error) {
    if (error.code === "ECONNREFUSED" || error.code === "42P01") {
      pgReachable = false;
    }
  }
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
