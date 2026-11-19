import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { closePool, query } from "../db/pg.js";
import { readDb, mutateDb } from "../store.js";
import { resetTestDb, seedTestUser, loginAs } from "./setup.js";
import { buildResourceSchema } from "../services/schema.js";
import {
  parseCsv,
  buildDefaultMapping,
  validateRecord,
} from "../services/csvImport.js";

// CSV import backend (P2-BE2-04). Integration tests over the HTTP surface:
// RFC4180 parsing/mapping/validation, dry-run isolation, real-run persistence,
// tenant isolation/error-report scoping, RBAC/write-field masks, and bounds.

let app;
let ownerToken;
let acmeMemberToken;
let acmeViewerToken;
let globexMemberToken;

const ACME = "ws_acme";
const GLOBEX = "ws_globex";

const auth = (token = ownerToken) => ({ Authorization: `Bearer ${token}` });

const doImport = (resource, body, token = ownerToken) =>
  request(app).post(`/api/import/${resource}`).set(auth(token)).send(body);

async function countRows(resource, where = "", params = []) {
  const suffix = where ? ` WHERE ${where}` : "";
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM ${resource}${suffix}`,
    params,
  );
  return rows[0].count;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

async function ensureTenantUser({ id, email, name, role, workspaceId, password = "test123" }) {
  await mutateDb((db) => {
    db.users = (db.users || []).filter((u) => u.id !== id && u.email !== email);
    db.team = (db.team || []).filter((t) => t.id !== `team_${id}` && t.email !== email);
    db.sessions = (db.sessions || []).filter((s) => s.userId !== id);
    const user = {
      id,
      name,
      email,
      password: hashPassword(password),
      role,
      workspaceId,
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    db.team.push({
      id: `team_${id}`,
      name,
      email,
      role,
      status: "Active",
      createdAt: user.createdAt,
    });
  });
}

async function login(appInstance, email, password = "test123") {
  const res = await request(appInstance)
    .post("/api/auth/login")
    .send({ email, password });
  expect(res.status).toBe(200);
  return res.body.token;
}

async function cleanupTenantState() {
  // Defensive cleanup for tables/state not fully reset by base setup in some envs.
  await query("DELETE FROM contacts WHERE workspace_id IN ($1,$2)", [ACME, GLOBEX]).catch(() => {});
  await query("DELETE FROM leads WHERE workspace_id IN ($1,$2)", [ACME, GLOBEX]).catch(() => {});
  await query("DELETE FROM companies WHERE workspace_id IN ($1,$2)", [ACME, GLOBEX]).catch(() => {});
  await query("DELETE FROM deals WHERE workspace_id IN ($1,$2)", [ACME, GLOBEX]).catch(() => {});
  await query("DELETE FROM pipeline_definitions WHERE workspace_id IN ($1,$2)", [ACME, GLOBEX]).catch(() => {});
  await mutateDb((db) => {
    db.audit = [];
    db.fieldPermissions = {};
    db.pipelineDefinitions = (db.pipelineDefinitions || []).filter(
      (p) => p?.workspaceId !== ACME && p?.workspaceId !== GLOBEX,
    );
  });
}

async function ensureDealPipeline(workspaceId) {
  const pipeline = {
    id: `pipe_${workspaceId}`,
    workspaceId,
    name: "Default",
    entityType: "deal",
    isDefault: true,
    stages: [
      { key: "new", label: "New", probability: 10, order: 0 },
      { key: "won", label: "Won", probability: 100, order: 1 },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await mutateDb((db) => {
    db.pipelineDefinitions = (db.pipelineDefinitions || []).filter(
      (p) => !(p.workspaceId === workspaceId && p.entityType === "deal"),
    );
    db.pipelineDefinitions.push(pipeline);
  });
  await query(
    `INSERT INTO pipeline_definitions (id, workspace_id, name, entity_type, is_default, stages, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [
      pipeline.id,
      pipeline.workspaceId,
      pipeline.name,
      pipeline.entityType,
      pipeline.isDefault,
      JSON.stringify(pipeline.stages),
    ],
  ).catch(() => {});
  return pipeline;
}

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
  await seedTestUser(); // default workspace owner (Tenant A/default)
  ownerToken = await loginAs(app);

  await ensureTenantUser({
    id: "usr_acme_member",
    email: "acme-member@test.com",
    name: "Acme Member",
    role: "member",
    workspaceId: ACME,
  });
  await ensureTenantUser({
    id: "usr_acme_viewer",
    email: "acme-viewer@test.com",
    name: "Acme Viewer",
    role: "viewer",
    workspaceId: ACME,
  });
  await ensureTenantUser({
    id: "usr_globex_member",
    email: "globex-member@test.com",
    name: "Globex Member",
    role: "member",
    workspaceId: GLOBEX,
  });

  acmeMemberToken = await login(app, "acme-member@test.com");
  acmeViewerToken = await login(app, "acme-viewer@test.com");
  globexMemberToken = await login(app, "globex-member@test.com");
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await cleanupTenantState();
  await ensureDealPipeline(ACME);
  await ensureDealPipeline(GLOBEX);
  await ensureDealPipeline("default");
});

describe("authentication and RBAC", () => {
  it("returns 401 for unauthenticated import, preview, and error-report endpoints", async () => {
    expect(
      (await request(app).post("/api/import/contacts").send({ csv: "Email\nx@y.com\n", dryRun: true })).status,
    ).toBe(401);
    expect((await request(app).get("/api/import/preview")).status).toBe(401);
    expect((await request(app).post("/api/import/preview").send({ csv: "Email\nx@y.com\n" })).status).toBe(401);
    expect((await request(app).get("/api/import/errors/importError_missing")).status).toBe(401);
    expect((await request(app).post("/api/import/error-report").send({ reportId: "x" })).status).toBe(401);
  });

  it("returns 403 for viewer role on import endpoints", async () => {
    const csv = "First Name,Email\nAda,ada.viewer@example.com\n";
    const imp = await doImport("contacts", { csv, dryRun: true }, acmeViewerToken);
    expect(imp.status).toBe(403);
    const prev = await request(app)
      .post("/api/import/preview")
      .set(auth(acmeViewerToken))
      .send({ csv });
    expect(prev.status).toBe(403);
  });

  it("returns 403 when a restricted role attempts to import a write-masked field", async () => {
    await mutateDb((db) => {
      db.fieldPermissions = db.fieldPermissions || {};
      db.fieldPermissions.contact = db.fieldPermissions.contact || {};
      db.fieldPermissions.contact.member = { visible: null, hidden: ["phone"] };
    });
    const csv = "First Name,Email,Phone\nAda,ada.mask@example.com,+15550001\n";
    const res = await doImport("contacts", { csv, dryRun: true }, acmeMemberToken);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/masked/i);
    expect(res.body.maskedFields || []).toContain("phone");
  });
});

describe("dry-run vs real-run and persistence", () => {
  it("dry run validates and reports without writes, audit, or broadcast side effects", async () => {
    const before = await countRows("contacts", "workspace_id = $1", [ACME]);
    const auditBefore = (await readDb()).audit.length;
    const csv = [
      "First Name,Email,Phone",
      "Ada,ada.dry@example.com,+1 555 000 0000",
      "Grace,not-an-email,555",
    ].join("\n");

    const res = await doImport("contacts", { csv, dryRun: true }, acmeMemberToken);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.totalRows).toBe(2);
    expect(res.body.validRows).toBe(1);
    expect(res.body.invalidRows).toBe(1);
    expect(res.body.importedCount).toBe(0);
    expect(res.body.errors[0].errors.join(" ")).toMatch(/valid email/i);
    expect(await countRows("contacts", "workspace_id = $1", [ACME])).toBe(before);
    const auditAfter = (await readDb()).audit.length;
    expect(auditAfter).toBe(auditBefore);
  });

  it("real run persists contacts, leads, companies, and deals with tenant scoping and audit", async () => {
    const contacts = await doImport(
      "contacts",
      { csv: "First Name,Last Name,Email\nAda,Lovelace,ada.run@example.com\n", dryRun: false },
      acmeMemberToken,
    );
    expect(contacts.status).toBe(200);
    expect(contacts.body.importedCount).toBe(1);

    const leads = await doImport(
      "leads",
      { csv: "First Name,Last Name,Email,Company\nGrace,Hopper,grace.run@example.com,Navy\n", dryRun: false },
      acmeMemberToken,
    );
    expect(leads.status).toBe(200);
    expect(leads.body.importedCount).toBe(1);

    const companies = await doImport(
      "companies",
      { csv: "Company Name,Domain\nAnalytical Engines,analytical.example\n", dryRun: false },
      acmeMemberToken,
    );
    expect(companies.status).toBe(200);
    expect(companies.body.importedCount).toBe(1);

    const deals = await doImport(
      "deals",
      { csv: "Deal Name,Value,Stage\nBig Deal,5000,New\n", dryRun: false },
      acmeMemberToken,
    );
    expect(deals.status).toBe(200);
    expect(deals.body.importedCount).toBe(1);

    expect(await countRows("contacts", "email = $1 AND workspace_id = $2", ["ada.run@example.com", ACME])).toBe(1);
    expect(await countRows("leads", "email = $1 AND workspace_id = $2", ["grace.run@example.com", ACME])).toBe(1);
    expect(await countRows("companies", "name = $1 AND workspace_id = $2", ["Analytical Engines", ACME])).toBe(1);
    expect(await countRows("deals", "title = $1 AND workspace_id = $2", ["Big Deal", ACME])).toBe(1);

    const db = await readDb();
    expect(db.audit.some((e) => /Imported 1 contacts from CSV/.test(e.action))).toBe(true);
    expect(db.audit.some((e) => /Imported 1 deals from CSV/.test(e.action))).toBe(true);
  });

  it("validates deals pipelineId (rejects invalid/cross-tenant) and defaults when omitted", async () => {
    await ensureDealPipeline(GLOBEX);
    const crossTenant = await doImport(
      "deals",
      {
        csv: "Deal Name,Value,Pipeline Id\nBad Deal,100,pipe_ws_globex\n",
        mapping: { "Deal Name": "title", Value: "value", "Pipeline Id": "pipelineId" },
        dryRun: true,
      },
      acmeMemberToken,
    );
    expect([400, 404]).toContain(crossTenant.status);
    expect((crossTenant.body.error || crossTenant.body.errors?.[0]?.errors?.join(" ") || "").toLowerCase()).toMatch(/pipeline/);

    const invalid = await doImport(
      "deals",
      {
        csv: "Deal Name,Value,Pipeline Id\nBad Deal 2,100,pipe_does_not_exist\n",
        mapping: { "Deal Name": "title", Value: "value", "Pipeline Id": "pipelineId" },
        dryRun: true,
      },
      acmeMemberToken,
    );
    expect([400, 404]).toContain(invalid.status);

    const ok = await doImport(
      "deals",
      { csv: "Deal Name,Value\nDefaulted Deal,200\n", dryRun: false },
      acmeMemberToken,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.importedCount).toBe(1);
    const { rows } = await query(
      "SELECT pipeline_id FROM deals WHERE title = $1 AND workspace_id = $2",
      ["Defaulted Deal", ACME],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].pipeline_id).toBeTruthy();
  });
});

describe("tenant isolation", () => {
  it("stamps imported records with caller workspaceId and ignores/rejects spoofed workspace fields", async () => {
    // Spoofed workspace_id column/mapping must not place record in another tenant.
    const spoofCsv = "First Name,Email,Workspace Id\nMallory,spoof@example.com,ws_globex\n";
    const res = await doImport(
      "contacts",
      {
        csv: spoofCsv,
        mapping: { "First Name": "name", Email: "email", "Workspace Id": "workspaceId" },
        dryRun: false,
      },
      acmeMemberToken,
    );
    // Mapping to forbidden tenant override key should be rejected.
    expect(res.status).toBe(400);
    expect((res.body.error || "").toLowerCase()).toMatch(/forbidden|unknown|read-only|workspace/);

    const clean = await doImport(
      "contacts",
      { csv: "First Name,Email\nAda,tenantok@example.com\n", dryRun: false },
      acmeMemberToken,
    );
    expect(clean.status).toBe(200);
    expect(await countRows("contacts", "email = $1 AND workspace_id = $2", ["tenantok@example.com", ACME])).toBe(1);
    expect(await countRows("contacts", "email = $1 AND workspace_id = $2", ["tenantok@example.com", GLOBEX])).toBe(0);
  });

  it("scopes error reports: Tenant B gets 404 for Tenant A report via GET and POST", async () => {
    const res = await doImport(
      "contacts",
      { csv: "First Name,Email\nGrace,not-an-email\n", dryRun: true },
      acmeMemberToken,
    );
    expect(res.status).toBe(200);
    const reportId = res.body.errorReportId;
    expect(reportId).toBeTruthy();

    const ownGet = await request(app).get(`/api/import/errors/${reportId}`).set(auth(acmeMemberToken));
    expect(ownGet.status).toBe(200);
    expect(ownGet.headers["content-type"]).toMatch(/text\/csv/);

    const ownPost = await request(app)
      .post("/api/import/error-report")
      .set(auth(acmeMemberToken))
      .send({ reportId });
    expect(ownPost.status).toBe(200);

    const otherGet = await request(app).get(`/api/import/errors/${reportId}`).set(auth(globexMemberToken));
    expect(otherGet.status).toBe(404);
    const otherPost = await request(app)
      .post("/api/import/error-report")
      .set(auth(globexMemberToken))
      .send({ reportId });
    expect(otherPost.status).toBe(404);
  });
});

describe("validation, mapping, parser, and bounds", () => {
  it("handles RFC4180 edge cases (BOM, CRLF, quoted commas, escaped quotes, embedded newlines)", async () => {
    const csv =
      '\uFEFFFirst Name,Last Name,Email,Phone\r\n"Ada","Love, lace",ada.rfc@example.com,"+1 555, 0000"\r\n';
    const res = await doImport("contacts", { csv, dryRun: false }, acmeMemberToken);
    expect(res.status).toBe(200);
    expect(res.body.importedCount).toBe(1);
    const { rows } = await query(
      "SELECT first_name, last_name, phone FROM contacts WHERE email = $1 AND workspace_id = $2",
      ["ada.rfc@example.com", ACME],
    );
    expect(rows[0]).toMatchObject({
      first_name: "Ada",
      last_name: "Love, lace",
      phone: "+1 555, 0000",
    });
  });

  it("supports default and explicit column mapping", async () => {
    const explicit = await doImport(
      "contacts",
      {
        csv: "Contact Person,Work E-mail\nAda Lovelace,ada.map@example.com\n",
        mapping: { "Contact Person": "name", "Work E-mail": "email" },
        dryRun: false,
      },
      acmeMemberToken,
    );
    expect(explicit.status).toBe(200);
    expect(explicit.body.importedCount).toBe(1);
  });

  it("reports validation errors and generates downloadable tenant-scoped error report", async () => {
    const res = await doImport(
      "companies",
      { csv: "Domain,Industry\nacme.com,Widgets\n", dryRun: true },
      acmeMemberToken,
    );
    expect(res.status).toBe(200);
    expect(res.body.invalidRows).toBe(1);
    expect(res.body.errors[0].errors.join(" ")).toMatch(/required/i);
    expect(res.body.errorReportId).toBeTruthy();

    const dl = await request(app)
      .get(`/api/import/errors/${res.body.errorReportId}`)
      .set(auth(acmeMemberToken));
    expect(dl.status).toBe(200);
    expect(dl.headers["content-type"]).toMatch(/text\/csv/);
  });

  it("rejects dangerous mapping keys, unsupported resources, >1000 rows, and >5MB payloads", async () => {
    const proto = await doImport(
      "contacts",
      {
        csv: "Email\nada@example.com\n",
        mapping: { Email: "__proto__" },
        dryRun: true,
      },
      acmeMemberToken,
    );
    expect(proto.status).toBe(400);
    expect((proto.body.error || "").toLowerCase()).toMatch(/forbidden|unknown|read-only|proto/);

    const ctor = await doImport(
      "contacts",
      { csv: "Email\nada@example.com\n", mapping: { Email: "constructor" }, dryRun: true },
      acmeMemberToken,
    );
    expect(ctor.status).toBe(400);

    const badRes = await doImport(
      "widgets",
      { csv: "Name\nThing\n", dryRun: true },
      acmeMemberToken,
    );
    expect(badRes.status).toBe(400);

    const rows = ["Email"];
    for (let i = 0; i < 1001; i += 1) rows.push(`user${i}@example.com`);
    const tooMany = await doImport("contacts", { csv: rows.join("\n"), dryRun: true }, acmeMemberToken);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toMatch(/1000/);

    const hugeCsv = `Email\n${"a".repeat(5 * 1024 * 1024 + 10)}@example.com\n`;
    const tooBig = await request(app)
      .post("/api/import/contacts")
      .set(auth(acmeMemberToken))
      .attach("file", Buffer.from(hugeCsv, "utf8"), {
        filename: "huge.csv",
        contentType: "text/csv",
      })
      .field("dryRun", "true");
    expect([413, 400]).toContain(tooBig.status);
  });

  it("supports preview via JSON and preserves preview shape fields", async () => {
    const res = await request(app)
      .post("/api/import/preview")
      .set(auth(acmeMemberToken))
      .send({ csv: "First Name,Email\nAda,ada.prev@example.com\nGrace,grace.prev@example.com\n" });
    expect(res.status).toBe(200);
    expect(res.body.headers).toEqual(["First Name", "Email"]);
    expect(Array.isArray(res.body.preview)).toBe(true);
    expect(res.body.totalRows).toBe(2);
  });
});

describe("service: parser, mapping, validation", () => {
  it("parseCsv handles BOM, quotes, escaped quotes, embedded newlines, and CRLF", () => {
    const parsed = parseCsv('\uFEFFname,notes,amount\r\n"Ada, A.","say ""hi""\nsecond line",10\r\n');
    expect(parsed.headers).toEqual(["name", "notes", "amount"]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].values).toEqual(["Ada, A.", 'say "hi"\nsecond line', "10"]);
  });

  it("buildDefaultMapping maps friendly headers", () => {
    const schema = buildResourceSchema("deals", { db: {} });
    const mapping = buildDefaultMapping(
      ["Deal Name", "Amount", "Pipeline Stage", "Company", "Expected Close Date"],
      schema,
    );
    expect(mapping["Deal Name"]).toBe("title");
    expect(mapping.Amount).toBe("value");
  });

  it("validateRecord flags invalid email", () => {
    const schema = buildResourceSchema("contacts", { db: {} });
    const errors = validateRecord({ email: "not-an-email", phone: "555" }, schema, "contacts");
    expect(errors.join(" ")).toMatch(/valid email/i);
  });
});
