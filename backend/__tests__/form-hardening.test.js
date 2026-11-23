import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { resetTestDb, cleanupTestDb } from "./setup.js";
import { query } from "../db/pg.js";
import { mutateDb } from "../store.js";
import * as repoIndex from "../db/repositories/index.js";

let pgReady = false;
try {
  await query("SELECT 1 FROM forms LIMIT 1");
  pgReady = true;
} catch (error) {
  console.warn(`[form-hardening] Postgres unavailable (${error.code || error.message}); skipping.`);
}

let app;
let token;

const EXTERNAL_ORIGIN = "https://external-client-website.com";

async function seedAuth() {
  const salt = crypto.randomBytes(16).toString("hex");
  const password = `${salt}:${crypto.scryptSync("test123", salt, 64).toString("hex")}`;
  token = crypto.randomBytes(32).toString("hex");
  await mutateDb((db) => {
    db.users.push({
      id: "usr_test",
      name: "Test User",
      email: "test@test.com",
      password,
      role: "Owner",
      createdAt: new Date().toISOString(),
    });
    db.sessions.push({
      token,
      userId: "usr_test",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });
}

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
  await seedAuth();
}, 30000);

beforeEach(async () => {
  await resetTestDb();
  await seedAuth();
});

afterAll(() => cleanupTestDb());

const authReq = (req) => req.set("Authorization", `Bearer ${token}`);

async function createForm({ permalink, name, submitTo = "lead", settings = {} }) {
  const res = await authReq(request(app).post("/api/forms")).send({
    name,
    permalink,
    submitTo,
    settings,
    fields: [{ key: "email", label: "Email", type: "email", required: true }],
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function counts() {
  const { rows } = await query(`SELECT
    (SELECT COUNT(*)::int FROM leads) AS leads,
    (SELECT COUNT(*)::int FROM contacts) AS contacts,
    (SELECT COUNT(*)::int FROM activities) AS activities`);
  return rows[0];
}

async function setFormAllowedOrigins(formId, origins) {
  await query(
    `UPDATE forms SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [formId, JSON.stringify({ allowedOrigins: origins })],
  );
}

describe.skipIf(!pgReady)("public form submission hardening", () => {
  it("answers OPTIONS preflight with CORS headers and 204", async () => {
    const form = await createForm({ permalink: "cors-preflight", name: "CORS Preflight" });
    const res = await request(app)
      .options(`/api/forms/${form.permalink}/submit`)
      .set("Origin", EXTERNAL_ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "Content-Type");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toMatch(/POST/);
    expect(res.headers["access-control-allow-methods"]).toMatch(/OPTIONS/);
    expect(res.headers["access-control-allow-headers"]).toMatch(/Content-Type/i);
    expect(res.headers["access-control-max-age"]).toBe("86400");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("enforces exact per-form allowedOrigins", async () => {
    const form = await createForm({ permalink: "allowlist-form", name: "Allowlist Form" });
    await setFormAllowedOrigins(form.id, ["https://allowed.example.com"]);

    const ok = await request(app)
      .post(`/api/forms/${form.permalink}/submit`)
      .set("Origin", "https://allowed.example.com")
      .send({ email: "ok@example.com" });
    expect(ok.status).toBe(201);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://allowed.example.com");
    expect(ok.headers.vary).toMatch(/Origin/);
    expect(ok.headers["access-control-allow-credentials"]).toBeUndefined();

    const bad = await request(app)
      .post(`/api/forms/${form.permalink}/submit`)
      .set("Origin", "https://evil-allowed.example.com")
      .send({ email: "bad@example.com" });
    expect(bad.status).toBe(403);

    const preflightBad = await request(app)
      .options(`/api/forms/${form.permalink}/submit`)
      .set("Origin", "https://evil-allowed.example.com")
      .set("Access-Control-Request-Method", "POST");
    expect(preflightBad.status).toBe(403);
  });

  it("creates cross-origin submission in the target form workspace only", async () => {
    await query(
      `INSERT INTO forms (
         id, workspace_id, name, title, permalink, submit_to, progressive,
         redirect_url, enabled, fields, settings, submission_count, created_by, custom_fields
       ) VALUES (
         'frm_ws_globex', 'ws_globex', 'Globex Intake', 'Globex Intake',
         'globex-intake', 'lead', true, '', true, $1::jsonb, '{}'::jsonb, 0,
         'tester', '{}'::jsonb
       )`,
      [JSON.stringify([{ key: "email", label: "Email", required: true }])],
    );
    const res = await request(app)
      .post("/api/forms/globex-intake/submit")
      .set("Origin", EXTERNAL_ORIGIN)
      .send({ email: "globex-visitor@example.com" });
    expect(res.status).toBe(201);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    const { rows } = await query("SELECT workspace_id FROM leads WHERE email = $1", ["globex-visitor@example.com"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe("ws_globex");
  });

  it.each(["_hp", "_gotcha", "website", "honeypot"])(
    "drops honeypot %s with 200 and zero writes",
    async (field) => {
      const form = await createForm({ permalink: `hp-${field}`, name: `HP ${field}` });
      const before = await counts();
      const res = await request(app)
        .post(`/api/forms/${form.permalink}/submit`)
        .send({ email: `bot-${field}@example.com`, [field]: "spam-value" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, message: "Submission received" });
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(await counts()).toEqual(before);
      const { rows } = await query("SELECT submission_count FROM forms WHERE id = $1", [form.id]);
      expect(Number(rows[0].submission_count)).toBe(0);
    },
  );

  it("accepts submission when honeypot fields are empty and strips them", async () => {
    const form = await createForm({ permalink: "clean-hp", name: "Clean HP" });
    const res = await request(app)
      .post(`/api/forms/${form.permalink}/submit`)
      .send({ email: "clean@example.com", _hp: "", _gotcha: "", website: "", honeypot: "" });
    expect(res.status).toBe(201);
    const { rows } = await query("SELECT custom_fields FROM leads WHERE email = $1", ["clean@example.com"]);
    expect(rows).toHaveLength(1);
    const custom = rows[0].custom_fields || {};
    expect(custom._hp).toBeUndefined();
    expect(custom._gotcha).toBeUndefined();
    expect(custom.website).toBeUndefined();
    expect(custom.honeypot).toBeUndefined();
  });

  it("rejects prototype pollution keys with 400", async () => {
    const form = await createForm({ permalink: "proto-form", name: "Proto Form" });
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const body = JSON.parse(`{"email":"x@example.com","${key}":{"polluted":true}}`);
      const res = await request(app).post(`/api/forms/${form.permalink}/submit`).send(body);
      expect(res.status).toBe(400);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    }
  });

  it("rejects oversized payloads and field counts with 400", async () => {
    const form = await createForm({ permalink: "bounds-form", name: "Bounds Form" });
    const tooMany = {};
    for (let i = 0; i < 51; i++) tooMany[`k${i}`] = "v";
    tooMany.email = "a@example.com";
    const manyRes = await request(app).post(`/api/forms/${form.permalink}/submit`).send(tooMany);
    expect(manyRes.status).toBe(400);

    const longRes = await request(app)
      .post(`/api/forms/${form.permalink}/submit`)
      .send({ email: "a@example.com", note: "x".repeat(10001) });
    expect(longRes.status).toBe(400);

    const longArray = await request(app)
      .post(`/api/forms/${form.permalink}/submit`)
      .send({ email: "a@example.com", tags: Array.from({ length: 101 }, (_, i) => `t${i}`) });
    expect(longArray.status).toBe(400);
  });

  it("returns sanitized 500 response on unexpected errors", async () => {
    const form = await createForm({ permalink: "err-form", name: "Err Form" });
    const spy = vi.spyOn(repoIndex, "repoFor").mockImplementation(() => {
      throw new Error("db-secret-leak");
    });
    try {
      const res = await request(app)
        .post(`/api/forms/${form.permalink}/submit`)
        .send({ email: "err@example.com" });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Internal server error" });
      expect(JSON.stringify(res.body)).not.toContain("db-secret-leak");
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    } finally {
      spy.mockRestore();
    }
  });
});
