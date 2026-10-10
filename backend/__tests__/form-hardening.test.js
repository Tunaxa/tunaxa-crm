// Form-submission hardening: CORS preflight for public embeds and honeypot bot
// detection.
//
// The public submit endpoint is intentionally reachable from any origin, so the
// browser has to get a 204 preflight answer plus the response headers that make
// a cross-origin JSON submission readable by the embedding page. Spam hardening
// works the other way: a recognised honeypot field that was filled in means an
// automated bot scraped every input on the page, so the submission is dropped
// with a convincing success and, crucially, nothing is written to PostgreSQL.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from "./setup.js";
import { query } from "../db/pg.js";

// Probed at module scope on purpose. `describe.skipIf()` is evaluated while
// Vitest is still collecting files, before any `beforeAll` runs, so a flag set
// inside a hook would skip every database assertion.
let pgReady = false;
try {
  await query("SELECT 1 FROM forms LIMIT 1");
  pgReady = true;
} catch (error) {
  console.warn(
    `[form-hardening] Postgres is unreachable (${error.code || error.message}) - skipping database and HTTP assertions. Set PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE and re-run.`,
  );
}

let app;
let token;

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
}, 30000);

afterAll(() => cleanupTestDb());

const auth = (req) => req.set("Authorization", `Bearer ${token}`);
const EXTERNAL_ORIGIN = "https://external-client-website.com";

async function counts() {
  const { rows } = await query(`SELECT
    (SELECT COUNT(*)::int FROM leads) AS leads,
    (SELECT COUNT(*)::int FROM contacts) AS contacts,
    (SELECT COUNT(*)::int FROM activities) AS activities`);
  return rows[0];
}

async function createForm({ permalink, name, submitTo = "lead" }) {
  const res = await auth(request(app).post("/api/forms")).send({
    name,
    permalink,
    submitTo,
    fields: [{ key: "email", label: "Email", type: "email", required: true }],
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe.skipIf(!pgReady)("public form submission hardening", () => {
  const permalink = "embed-contact-form";
  let form;

  beforeAll(async () => {
    form = await createForm({ permalink, name: "Embed Contact Form" });
  });

  it("answers OPTIONS preflight with CORS headers and 204", async () => {
    const res = await request(app)
      .options(`/api/forms/${permalink}/submit`)
      .set("Origin", EXTERNAL_ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "Content-Type");
    expect([200, 204]).toContain(res.status);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toMatch(/POST/);
    expect(res.headers["access-control-allow-methods"]).toMatch(/OPTIONS/);
    expect(res.headers["access-control-allow-headers"]).toMatch(/Content-Type/);
    expect(res.headers["access-control-max-age"]).toBe("86400");
  });

  it("accepts a cross-origin submission and stores it in the form's workspace", async () => {
    const before = await counts();
    const res = await request(app)
      .post(`/api/forms/${permalink}/submit`)
      .set("Origin", EXTERNAL_ORIGIN)
      .send({ email: "visitor@example.com", _hp: "" });
    expect(res.status).toBe(201);
    expect(res.headers["access-control-allow-origin"]).toBe("*");

    const { rows } = await query(
      "SELECT email, workspace_id, custom_fields FROM leads WHERE email = $1",
      ["visitor@example.com"],
    );
    expect(rows).toHaveLength(1);
    // seedTestUser leaves workspace off the form owner, so the form lands in
    // the `default` tenant and the anonymous submission must inherit it.
    expect(rows[0].workspace_id).toBe("default");
    expect(await counts()).toEqual({
      leads: before.leads + 1,
      contacts: before.contacts,
      activities: before.activities + 1,
    });

    const { rows: counter } = await query(
      "SELECT submission_count FROM forms WHERE id = $1",
      [form.id],
    );
    expect(counter[0].submission_count).toBe(1);
  });

  it.each(["_hp", "_gotcha", "honeypot", "website"])(
    "drops a bot submission that filled %s: 200 with zero database writes",
    async (honeypot) => {
      const before = await counts();
      const res = await request(app)
        .post(`/api/forms/${permalink}/submit`)
        .send({
          email: `spambot-${honeypot}@automated-crawl.ru`,
          name: "Spam Bot",
          [honeypot]: `https://buy-cheap-leads.com/${honeypot}`,
        });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        message: "Submission received",
      });
      expect(res.headers["access-control-allow-origin"]).toBe("*");

      // No lead, no contact, no activity, and the submission counter must not
      // move either -- the drop happens before any write path runs.
      expect(await counts()).toEqual(before);
      const { rows: counter } = await query(
        "SELECT submission_count FROM forms WHERE id = $1",
        [form.id],
      );
      expect(counter[0].submission_count).toBe(1);
    },
  );

  it("files a submission into the form's own workspace, not a caller-derived tenant", async () => {
    // The row is seeded directly under ws_globex: an anonymous submitter has no
    // session, so the workspace has to come from the form definition alone.
    await query(
      `INSERT INTO forms (
         id, workspace_id, name, title, permalink, submit_to, progressive,
         redirect_url, enabled, fields, settings, submission_count, created_by, custom_fields
       ) VALUES (
         'frm_globex_intake', 'ws_globex', 'Globex Intake', 'Globex Intake',
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

    const { rows } = await query(
      "SELECT workspace_id FROM leads WHERE email = $1",
      ["globex-visitor@example.com"],
    );
    expect(rows[0].workspace_id).toBe("ws_globex");
  });

  it("returns 404 for a submission to an unknown form and writes nothing", async () => {
    const before = await counts();
    const res = await request(app)
      .post("/api/forms/no-such-form/submit")
      .set("Origin", EXTERNAL_ORIGIN)
      .send({ email: "nobody@example.com" });
    expect(res.status).toBe(404);
    expect(await counts()).toEqual(before);
  });

  it("404 wins over the honeypot drop: lookup precedes detection", async () => {
    const res = await request(app)
      .post("/api/forms/ghost-form/submit")
      .send({ email: "x@y.z", _hp: "spam" });
    expect(res.status).toBe(404);
  });
});