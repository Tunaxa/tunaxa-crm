// Atomic merge + fuzzy duplicate detection.
//
// The point of the rollback test is that the failure is injected into a *real*
// transaction: the pool client is wrapped so that one statement rejects, so
// BEGIN / the FOR UPDATE locks / the activities re-point all genuinely execute
// before deals fails, and the ROLLBACK has real work to undo. A mocked service
// call would prove nothing about atomicity.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { resetTestDb, cleanupTestDb } from "./setup.js";
import { mutateDb } from "../store.js";
import { query, getPool } from "../db/pg.js";
import { mergeRecords, MergeError, MERGE_RESOURCES } from "../services/merge.js";
import {
  findDuplicates,
  emailMetric,
  nameMetric,
  phoneMetric,
  normalizePhone,
  normalizeText,
  jaroWinkler,
  trigramSimilarity,
  WEIGHTS,
} from "../services/dedup.js";

// This file issues well over the 120 req/min global limiter's budget across the
// four scenarios, so raise only that ceiling - before the server module is read.
process.env.RATE_LIMIT_GLOBAL_MAX = "100000";

const ACME = "ws_acme";
const GLOBEX = "ws_globex";

let app;
const tokens = { acme: "", globex: "", viewer: "" };

// Whether a migrated database is reachable. Everything except the pure scoring
// assertions needs it: contacts, companies and leads are served from Postgres,
// not from the JSON store.
//
// Probed at module scope on purpose. `describe.skipIf()` is evaluated while
// Vitest is still collecting files, which is before any `beforeAll` runs, so a
// flag set inside `beforeAll` would skip every database assertion and the
// database half of this file would never execute.
let pgReady = false;
try {
  await query("SELECT 1 FROM contacts LIMIT 1");
  pgReady = true;
} catch (error) {
  console.warn(
    `[atomic-merge-fuzzy] Postgres is unreachable (${error.code || error.message}) - skipping every database and HTTP assertion. Set PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE and re-run.`,
  );
}

function makePassword() {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("test123", salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function seedUser(id, email, role, workspaceId) {
  return {
    id,
    name: email.split("@")[0],
    email,
    password: makePassword(),
    role,
    workspaceId,
    createdAt: new Date().toISOString(),
  };
}

async function seedSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await mutateDb((db) => {
    db.sessions.push({
      token,
      userId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });
  return token;
}

const asAcme = () => ({ Authorization: `Bearer ${tokens.acme}` });
const asGlobex = () => ({ Authorization: `Bearer ${tokens.globex}` });
const asViewer = () => ({ Authorization: `Bearer ${tokens.viewer}` });

beforeAll(async () => {
  await resetTestDb();

  const mod = await import("../server.js");
  app = mod.app;

  await mutateDb((db) => {
    db.users.unshift(seedUser("usr_acme", "acme@test.com", "Owner", ACME));
    db.users.unshift(seedUser("usr_globex", "globex@test.com", "Owner", GLOBEX));
    db.users.unshift(seedUser("usr_viewer", "viewer@test.com", "viewer", ACME));
  });
  tokens.acme = await seedSession("usr_acme");
  tokens.globex = await seedSession("usr_globex");
  tokens.viewer = await seedSession("usr_viewer");
});

afterAll(() => cleanupTestDb());

// ---------------------------------------------------------------------------
// Seeding + reading helpers. Rows go in through SQL so ids, tenants and the
// exact custom_fields payloads are deterministic.
// ---------------------------------------------------------------------------

async function seedContact({ id, workspaceId = ACME, first, last, email, phone, custom = {} }) {
  await query(
    `INSERT INTO contacts (id, workspace_id, first_name, last_name, email, phone, custom_fields)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [id, workspaceId, first, last, email, phone, JSON.stringify(custom)],
  );
}

async function seedDeal({ id, workspaceId = ACME, title, contactId, companyId = null }) {
  await query(
    `INSERT INTO deals (id, workspace_id, title, contact_id, company_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, workspaceId, title, contactId, companyId],
  );
}

async function seedActivity({ id, workspaceId = ACME, title, contactId, recordId = null, entityType = null, entityId = null }) {
  await query(
    `INSERT INTO activities (id, workspace_id, type, title, contact_id, record_id, entity_type, entity_id)
     VALUES ($1, $2, 'Note', $3, $4, $5, $6, $7)`,
    [id, workspaceId, title, contactId, recordId, entityType, entityId],
  );
}

async function seedTask({ id, workspaceId = ACME, title, contactId, dealId = null }) {
  await query(
    `INSERT INTO tasks (id, workspace_id, title, contact_id, deal_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, workspaceId, title, contactId, dealId],
  );
}

async function seedCompany({ id, workspaceId = ACME, name, domain = null }) {
  await query(
    `INSERT INTO companies (id, workspace_id, name, domain)
     VALUES ($1, $2, $3, $4)`,
    [id, workspaceId, name, domain],
  );
}

/** Normalized snapshot of every row the merge could touch. */
async function snapshotState() {
  const [contacts, deals, activities, tasks] = await Promise.all([
    query("SELECT id, workspace_id, first_name, last_name, email, phone, title, custom_fields FROM contacts ORDER BY id"),
    query("SELECT id, workspace_id, title, contact_id, company_id FROM deals ORDER BY id"),
    query("SELECT id, workspace_id, type, title, contact_id, record_id, entity_type, entity_id FROM activities ORDER BY id"),
    query("SELECT id, workspace_id, title, contact_id, deal_id FROM tasks ORDER BY id"),
  ]);
  return {
    contacts: contacts.rows,
    deals: deals.rows,
    activities: activities.rows,
    tasks: tasks.rows,
  };
}

/**
 * Make the next pool checkout fail on one statement.
 *
 * The wrapper lives on the pooled client, which is recycled, so it is gated on a
 * mutable flag instead of being torn off: `disarm()` leaves a pass-through in
 * place for every later test that borrows the same client.
 */
function failStatementMatching(pattern) {
  const pool = getPool();
  const realConnect = pool.connect.bind(pool);
  let armed = true;
  const spy = vi.spyOn(pool, "connect").mockImplementation(async () => {
    const client = await realConnect();
    if (client.__mergeFailing) return client;
    client.__mergeFailing = true;
    const realQuery = client.query.bind(client);
    client.query = (text, params) => {
      if (armed && typeof text === "string" && pattern.test(text)) {
        const error = new Error("injected failure: connection lost mid-merge");
        error.code = "08006";
        return Promise.reject(error);
      }
      return realQuery(text, params);
    };
    return client;
  });
  return () => {
    armed = false;
    spy.mockRestore();
  };
}

// ===========================================================================
describe("Weighted fuzzy scoring", () => {
  it("weights sum to 1", () => {
    const total = Object.values(WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(WEIGHTS).toEqual({ email: 0.4, name: 0.35, phone: 0.15, company: 0.1 });
  });

  it("scores a typo'd surname as a near match", () => {
    expect(nameMetric("Sarah Connor", "Sara Conner").score).toBeGreaterThan(0.85);
    expect(nameMetric("Jonathon Smith", "Jonathan Smith").score).toBeGreaterThan(0.9);
  });

  it("gives an exact normalized email 1.0 and a near-miss 0.5", () => {
    expect(emailMetric("sarah.connor@acme.com", "SARAH.CONNOR@ACME.COM")).toEqual({
      score: 1,
      available: true,
      exact: true,
    });
    expect(emailMetric("sarah.connor@acme.com", "s.connor@acme.com").score).toBe(0.5);
    expect(emailMetric("sarah.connor@acme.com", "s.connor@globex.com").score).toBeLessThan(0.5);
  });

  it("normalizes phone formatting and reads a transposition as partial evidence", () => {
    expect(normalizePhone("+1 (415) 555-0100")).toBe("4155550100");
    expect(normalizePhone("415.555.0100")).toBe("4155550100");
    expect(phoneMetric("+1 (415) 555-0100", "4155550100").score).toBe(1);
    expect(phoneMetric("555-0100", "555-0010").score).toBe(0.75);
    expect(phoneMetric("+14155552233", "+12125558890").score).toBe(0);
  });

  it("keeps the blended string distance in [0,1] and ordered", () => {
    expect(jaroWinkler("abc", "abc")).toBe(1);
    expect(jaroWinkler("", "abc")).toBe(0);
    expect(trigramSimilarity("abc", "xyz")).toBe(0);
    expect(jaroWinkler("jonathan", "jonathon")).toBeGreaterThan(jaroWinkler("jonathan", "xzq"));
    expect(normalizeText("Sarah, O'Connor-Smith")).toBe("sarah o connor smith");
  });
});

// ===========================================================================
describe.skipIf(!pgReady)("Atomic merge: rollback on a mid-merge failure", () => {
  beforeAll(async () => {
    await query("TRUNCATE TABLE activities, tasks, deals, contacts CASCADE");
    await seedContact({
      id: "cnt_primary",
      first: "Jonathan",
      last: "Davis",
      email: "jdavis@acme.com",
      phone: "555-0100",
      custom: { tier: "gold", region: "west" },
    });
    await seedContact({
      id: "cnt_secondary",
      first: "Jonathan",
      last: "Davies",
      email: "jdavis@acme.co.uk",
      phone: "555-0111",
      custom: { tier: "silver", source: "web" },
    });
    await seedDeal({ id: "deal_primary", title: "Primary deal", contactId: "cnt_primary" });
    await seedDeal({ id: "deal_secondary", title: "Secondary deal", contactId: "cnt_secondary" });
    await seedActivity({ id: "act_primary", title: "Primary note", contactId: "cnt_primary" });
    await seedActivity({
      id: "act_secondary",
      title: "Secondary note",
      contactId: "cnt_secondary",
      recordId: "cnt_secondary",
      entityType: "contact",
      entityId: "cnt_secondary",
    });
    await seedTask({ id: "task_secondary", title: "Secondary task", contactId: "cnt_secondary" });
  });

  it("leaves every record untouched when a child re-point fails", async () => {
    const before = await snapshotState();

    // deals is the second child table in the plan, so activities has already been
    // re-pointed by the time this rejects - the rollback has real work to undo.
    const disarm = failStatementMatching(/^\s*UPDATE\s+deals\b/i);
    try {
      await expect(
        mergeRecords({
          resource: "contacts",
          primaryId: "cnt_primary",
          secondaryId: "cnt_secondary",
          fieldOverrides: { phone: "555-0199" },
          workspaceId: ACME,
        }),
      ).rejects.toThrow(/injected failure/);
    } finally {
      disarm();
    }

    expect(await snapshotState()).toEqual(before);

    // Spelled out as well, so a failure names the invariant it broke.
    const contacts = await query("SELECT * FROM contacts ORDER BY id");
    expect(contacts.rows.map((row) => row.id)).toEqual(["cnt_primary", "cnt_secondary"]);
    const primary = contacts.rows[0];
    expect(primary.phone).toBe("555-0100");
    expect(primary.email).toBe("jdavis@acme.com");
    expect(primary.custom_fields).toEqual({ tier: "gold", region: "west" });

    const deals = await query("SELECT id, contact_id FROM deals ORDER BY id");
    expect(deals.rows).toEqual([
      { id: "deal_primary", contact_id: "cnt_primary" },
      { id: "deal_secondary", contact_id: "cnt_secondary" },
    ]);

    const activities = await query("SELECT id, contact_id, record_id, entity_id FROM activities ORDER BY id");
    expect(activities.rows).toEqual([
      { id: "act_primary", contact_id: "cnt_primary", record_id: null, entity_id: null },
      {
        id: "act_secondary",
        contact_id: "cnt_secondary",
        record_id: "cnt_secondary",
        entity_id: "cnt_secondary",
      },
    ]);

    const tasks = await query("SELECT id, contact_id FROM tasks ORDER BY id");
    expect(tasks.rows).toEqual([{ id: "task_secondary", contact_id: "cnt_secondary" }]);

    // The audit row is written last, so a rollback must leave none behind.
    const audit = await query("SELECT id FROM activities WHERE type = 'Merge'");
    expect(audit.rowCount).toBe(0);
  });

  it("survives a second attempt once the failure is gone", async () => {
    const result = await mergeRecords({
      resource: "contacts",
      primaryId: "cnt_primary",
      secondaryId: "cnt_secondary",
      fieldOverrides: { phone: "555-0199" },
      workspaceId: ACME,
    });
    expect(result.success).toBe(true);
    expect(result.mode).toBe("pg");
    expect(result.mergedRecord.phone).toBe("555-0199");
  });
});

// ===========================================================================
describe.skipIf(!pgReady)("Atomic merge: successful merge", () => {
  beforeAll(async () => {
    await query("TRUNCATE TABLE activities, tasks, deals, contacts CASCADE");
    await seedContact({
      id: "cnt_primary",
      first: "Jonathan",
      last: "Davis",
      email: "jdavis@acme.com",
      phone: "555-0100",
      custom: { tier: "gold", region: "west" },
    });
    await seedContact({
      id: "cnt_secondary",
      first: "Jonathan",
      last: "Davies",
      email: "jdavis@acme.co.uk",
      phone: "555-0111",
      custom: { tier: "silver", source: "web" },
    });
    await seedDeal({ id: "deal_primary", title: "Primary deal", contactId: "cnt_primary" });
    await seedDeal({ id: "deal_secondary", title: "Secondary deal", contactId: "cnt_secondary" });
    await seedActivity({
      id: "act_secondary",
      title: "Secondary note",
      contactId: "cnt_secondary",
      recordId: "cnt_secondary",
      entityType: "contact",
      entityId: "cnt_secondary",
    });
    await seedTask({ id: "task_secondary", title: "Secondary task", contactId: "cnt_secondary" });
  });

  it("merges fields, keeps the survivor's custom keys and re-points every child", async () => {
    const result = await mergeRecords({
      resource: "contacts",
      primaryId: "cnt_primary",
      secondaryId: "cnt_secondary",
      fieldOverrides: { phone: "555-0199", title: "VP Sales", loyaltyTier: "platinum" },
      workspaceId: ACME,
      actor: "Test User",
    });

    expect(result.success).toBe(true);
    expect(result.mergedSecondaryId).toBe("cnt_secondary");
    expect(result.deletedSecondary).toBe(true);
    // activities carries three pointers to a contact (contact_id, record_id,
    // entity_id), deals and tasks one each.
    expect(result.repointedCounts).toEqual({ activities: 3, deals: 1, tasks: 1 });

    const contacts = await query("SELECT * FROM contacts");
    expect(contacts.rowCount).toBe(1);
    const primary = contacts.rows[0];
    // Explicit override wins...
    expect(primary.phone).toBe("555-0199");
    expect(primary.title).toBe("VP Sales");
    // ...the survivor keeps its own values elsewhere...
    expect(primary.email).toBe("jdavis@acme.com");
    expect(primary.first_name).toBe("Jonathan");
    // ...custom_fields adopt what the duplicate adds, keeping the survivor's
    // value on the key they share, and an unknown override key lands in the bag.
    expect(primary.custom_fields).toEqual({
      tier: "gold",
      region: "west",
      source: "web",
      loyaltyTier: "platinum",
    });

    const deals = await query("SELECT id, contact_id FROM deals ORDER BY id");
    expect(deals.rows.map((row) => row.contact_id)).toEqual(["cnt_primary", "cnt_primary"]);

    const activities = await query(
      "SELECT id, contact_id, record_id, entity_type, entity_id FROM activities WHERE id = 'act_secondary'",
    );
    expect(activities.rows[0]).toMatchObject({
      contact_id: "cnt_primary",
      record_id: "cnt_primary",
      entity_type: "contact",
      entity_id: "cnt_primary",
    });

    const tasks = await query("SELECT id, contact_id FROM tasks");
    expect(tasks.rows).toEqual([{ id: "task_secondary", contact_id: "cnt_primary" }]);
  });

  it("records the merge on the survivor's timeline with the original id", async () => {
    const audit = await query(
      "SELECT * FROM activities WHERE type = 'Merge' ORDER BY created_at DESC LIMIT 1",
    );
    expect(audit.rowCount).toBe(1);
    const row = audit.rows[0];
    expect(row.workspace_id).toBe(ACME);
    expect(row.record_id).toBe("cnt_primary");
    expect(row.contact_id).toBe("cnt_primary");
    expect(row.metadata.merge.secondaryId).toBe("cnt_secondary");
    expect(row.metadata.merge.resource).toBe("contacts");
    expect(row.metadata.merge.mergedSecondary.email).toBe("jdavis@acme.co.uk");
    expect(row.metadata.merge.repointedCounts).toEqual({ activities: 3, deals: 1, tasks: 1 });
    expect(row.metadata.merge.actor).toBe("Test User");
  });
});

// ===========================================================================
describe.skipIf(!pgReady)("Atomic merge: dry run", () => {
  beforeAll(async () => {
    await query("TRUNCATE TABLE activities, tasks, deals, contacts CASCADE");
    await seedContact({ id: "dry_primary", first: "Ada", last: "Lovelace", email: "ada@acme.com" });
    await seedContact({ id: "dry_secondary", first: "Ada", last: "Lovelace", email: "ada@acme.com" });
    await seedDeal({ id: "dry_deal", title: "Dry deal", contactId: "dry_secondary" });
  });

  it("reports the plan without writing anything", async () => {
    const before = await snapshotState();
    const result = await mergeRecords({
      resource: "contacts",
      primaryId: "dry_primary",
      secondaryId: "dry_secondary",
      fieldOverrides: { phone: "555-0000" },
      workspaceId: ACME,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.mergedRecord.phone).toBe("555-0000");
    expect(result.repointedCounts).toEqual({ deals: 1 });
    expect(await snapshotState()).toEqual(before);
  });
});

// ===========================================================================
describe.skipIf(!pgReady)("Merge input validation", () => {
  beforeAll(async () => {
    await query("TRUNCATE TABLE activities, tasks, deals, contacts CASCADE");
    await seedContact({ id: "val_primary", first: "Grace", last: "Hopper", email: "grace@acme.com" });
  });

  it("rejects an unsupported resource, missing ids and a self-merge with 400", async () => {
    for (const input of [
      { resource: "deals", primaryId: "a", secondaryId: "b" },
      { resource: "contacts", primaryId: "val_primary" },
      { resource: "contacts", primaryId: "val_primary", secondaryId: "val_primary" },
    ]) {
      await expect(mergeRecords({ workspaceId: ACME, ...input })).rejects.toMatchObject({
        status: 400,
      });
    }
  });

  it("answers 404 for a record that does not exist", async () => {
    const failure = mergeRecords({
      resource: "contacts",
      primaryId: "val_primary",
      secondaryId: "nope",
      workspaceId: ACME,
    });
    await expect(failure).rejects.toBeInstanceOf(MergeError);
    await expect(failure).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("exposes exactly the resources it can merge", () => {
    expect([...MERGE_RESOURCES.keys()].sort()).toEqual(["companies", "contacts", "leads"]);
  });
});

// ===========================================================================
describe.skipIf(!pgReady)("Fuzzy duplicate detection", () => {
  beforeAll(async () => {
    await query("TRUNCATE TABLE activities, tasks, deals, contacts, companies CASCADE");

    // Typo'd name, identical email, two transposed phone digits.
    await seedContact({
      id: "dup_1",
      first: "Sarah",
      last: "Connor",
      email: "sarah.connor@acme.com",
      phone: "555-0100",
    });
    await seedContact({
      id: "dup_2",
      first: "Sara",
      last: "Conner",
      email: "sarah.connor@acme.com",
      phone: "555-0010",
    });
    // Same person again, but only the email local part is abbreviated, so the
    // email heuristic gives it 0.5 and the pair ranks below the one above.
    await seedContact({
      id: "mid_1",
      first: "Robert",
      last: "Nguyen",
      email: "rob.nguyen@initech.dev",
      phone: "+1 (212) 555-8890",
    });
    await seedContact({
      id: "mid_2",
      first: "Roberto",
      last: "Nguyen",
      email: "r.nguyen@initech.dev",
      phone: "+1 212 555 8890",
    });
    // Nothing in common with either pair.
    await seedContact({ id: "far_1", first: "Emily", last: "Rodriguez", email: "erodriguez@initech.dev", phone: "+1 (212) 555-4417" });
    await seedContact({ id: "far_2", first: "Tomasz", last: "Kowalski", email: "tkowalski@lakeside.pl", phone: "+48 22 555 0134" });

    await seedCompany({ id: "cmp_1", name: "Acme Corporation", domain: "acme.com" });
    await seedCompany({ id: "cmp_2", name: "Acme Corporaton", domain: "acme.com" });
  });

  it("returns the typo'd pair first and orders results by confidence", async () => {
    const res = await request(app)
      .get("/api/contacts/duplicates?threshold=0.7&limit=25")
      .set(asAcme());

    expect(res.status).toBe(200);
    expect(res.body.threshold).toBe(0.7);
    expect(res.body.limit).toBe(25);
    expect(res.body.exhaustive).toBe(true);

    const duplicates = res.body.duplicates;
    expect(duplicates.length).toBeGreaterThanOrEqual(2);

    // Strictly non-increasing: the endpoint's whole contract.
    for (let i = 1; i < duplicates.length; i++) {
      expect(duplicates[i].confidence).toBeLessThanOrEqual(duplicates[i - 1].confidence);
    }
    for (const pair of duplicates) {
      expect(pair.confidence).toBeGreaterThanOrEqual(0.7);
      expect(pair.confidence).toBeLessThanOrEqual(1);
      expect(Object.keys(pair.breakdown).sort()).toEqual(["company", "email", "name", "phone"]);
    }

    const top = duplicates[0];
    expect([top.primary.id, top.candidate.id].sort()).toEqual(["dup_1", "dup_2"]);
    expect(top.matchedFields).toContain("email");
    expect(top.matchedFields).toContain("name");
    expect(top.breakdown.email).toBe(1);
    expect(top.breakdown.name).toBeGreaterThan(0.85);
    expect(top.breakdown.phone).toBe(0.75);

    const ids = duplicates.flatMap((pair) => [pair.primary.id, pair.candidate.id]);
    expect(ids).toContain("mid_1");
    expect(ids).toContain("mid_2");
  });

  it("never returns unrelated contacts", async () => {
    const res = await request(app).get("/api/contacts/duplicates").set(asAcme());
    expect(res.status).toBe(200);
    const ids = res.body.duplicates.flatMap((pair) => [pair.primary.id, pair.candidate.id]);
    expect(ids).not.toContain("far_1");
    expect(ids).not.toContain("far_2");
    expect(res.body.duplicates.some((pair) => pair.primary.id === "far_1" || pair.candidate.id === "far_1")).toBe(false);
  });

  it("raises the bar when the threshold does", async () => {
    const loose = await request(app).get("/api/contacts/duplicates?threshold=0.5").set(asAcme());
    const strict = await request(app).get("/api/contacts/duplicates?threshold=0.95").set(asAcme());
    expect(loose.body.duplicates.length).toBeGreaterThanOrEqual(strict.body.duplicates.length);
    for (const pair of strict.body.duplicates) expect(pair.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("honours the limit", async () => {
    const res = await request(app).get("/api/contacts/duplicates?limit=1").set(asAcme());
    expect(res.body.duplicates).toHaveLength(1);
  });

  it("detects company duplicates by name and domain", async () => {
    const res = await request(app).get("/api/companies/duplicates?threshold=0.65").set(asAcme());
    expect(res.status).toBe(200);
    const pair = res.body.duplicates.find(
      (entry) => [entry.primary.id, entry.candidate.id].includes("cmp_1"),
    );
    expect(pair).toBeTruthy();
    expect([pair.primary.id, pair.candidate.id].sort()).toEqual(["cmp_1", "cmp_2"]);
    // No email and no phone on a company: the two name-shaped metrics carry it,
    // which is what the weight redistribution is for.
    expect(pair.confidence).toBeGreaterThan(0.9);
    expect(pair.breakdown.email).toBe(0);
    expect(pair.breakdown.phone).toBe(0);
  });

  it("requires authentication and leaves other resources to their own handlers", async () => {
    expect((await request(app).get("/api/contacts/duplicates")).status).toBe(401);
    // Not a dedup resource: falls through to the generic record read, which
    // reports the literal segment as an unknown id rather than scoring it.
    const fallthrough = await request(app).get("/api/products/duplicates").set(asAcme());
    expect(fallthrough.status).toBe(404);
  });

  it("exposes the same ranking through the service entry point", async () => {
    const viaHttp = await request(app).get("/api/contacts/duplicates").set(asAcme());
    const viaService = await findDuplicates({
      resource: "contacts",
      workspaceId: ACME,
      threshold: 0.65,
      limit: 50,
    });
    expect(viaService.map((pair) => pair.confidence)).toEqual(
      viaHttp.body.duplicates.map((pair) => pair.confidence),
    );
  });
});

// ===========================================================================
describe.skipIf(!pgReady)("Merge over HTTP", () => {
  beforeAll(async () => {
    await query("TRUNCATE TABLE activities, tasks, deals, contacts CASCADE");
    await seedContact({ id: "http_primary", first: "Priya", last: "Nair", email: "priya@acme.com", phone: "555-0700" });
    await seedContact({ id: "http_secondary", first: "Priyaa", last: "Nair", email: "priya@acme.com", phone: "555-0701" });
    await seedDeal({ id: "http_deal", title: "HTTP deal", contactId: "http_secondary" });
  });

  it("merges and reports the re-pointed counts", async () => {
    const res = await request(app)
      .post("/api/contacts/merge")
      .set(asAcme())
      .send({
        resource: "contacts",
        primaryId: "http_primary",
        secondaryId: "http_secondary",
        fieldOverrides: { phone: "555-0700" },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.mergedRecord.id).toBe("http_primary");
    expect(res.body.repointedCounts).toEqual({ deals: 1 });

    const contacts = await query("SELECT id FROM contacts");
    expect(contacts.rows.map((row) => row.id)).toEqual(["http_primary"]);
    const deals = await query("SELECT contact_id FROM deals WHERE id = 'http_deal'");
    expect(deals.rows[0].contact_id).toBe("http_primary");
  });

  it("answers 404 when either id is unknown", async () => {
    const res = await request(app)
      .post("/api/contacts/merge")
      .set(asAcme())
      .send({ primaryId: "http_primary", secondaryId: "does_not_exist" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("answers 400 for a malformed request and 403 for a read-only role", async () => {
    const bad = await request(app)
      .post("/api/contacts/merge")
      .set(asAcme())
      .send({ primaryId: "http_primary", secondaryId: "http_primary" });
    expect(bad.status).toBe(400);

    const forbidden = await request(app)
      .post("/api/contacts/merge")
      .set(asViewer())
      .send({ primaryId: "http_primary", secondaryId: "http_secondary" });
    expect(forbidden.status).toBe(403);
  });

  it("requires authentication", async () => {
    expect(
      (await request(app).post("/api/contacts/merge").send({ primaryId: "a", secondaryId: "b" })).status,
    ).toBe(401);
  });
});

// ===========================================================================
describe.skipIf(!pgReady)("Multi-tenant isolation", () => {
  beforeAll(async () => {
    await query("TRUNCATE TABLE activities, tasks, deals, contacts CASCADE");
    // Same person, same address, in the other tenant.
    await seedContact({
      id: "acme_1",
      workspaceId: ACME,
      first: "Sarah",
      last: "Connor",
      email: "sarah.connor@acme.com",
      phone: "555-0100",
    });
    await seedContact({
      id: "acme_2",
      workspaceId: ACME,
      first: "Sara",
      last: "Conner",
      email: "sarah.connor@acme.com",
      phone: "555-0010",
    });
    await seedContact({
      id: "globex_1",
      workspaceId: GLOBEX,
      first: "Sara",
      last: "Conner",
      email: "s.connor@acme.com",
      phone: "555-0010",
    });
    await seedContact({
      id: "globex_2",
      workspaceId: GLOBEX,
      first: "Sara",
      last: "Conner",
      email: "s.connor@acme.com",
      phone: "555-0010",
    });
  });

  it("scores only the caller's tenant", async () => {
    const acme = await request(app).get("/api/contacts/duplicates").set(asAcme());
    const globex = await request(app).get("/api/contacts/duplicates").set(asGlobex());

    const acmeIds = acme.body.duplicates.flatMap((pair) => [pair.primary.id, pair.candidate.id]);
    const globexIds = globex.body.duplicates.flatMap((pair) => [pair.primary.id, pair.candidate.id]);

    expect(acmeIds.sort()).toEqual(["acme_1", "acme_2"]);
    expect(globexIds.sort()).toEqual(["globex_1", "globex_2"]);
    expect(acme.body.scanned).toBe(2);
    expect(globex.body.scanned).toBe(2);
  });

  it("refuses a cross-tenant merge and leaves both records untouched", async () => {
    const before = await snapshotState();

    await expect(
      mergeRecords({
        resource: "contacts",
        primaryId: "acme_1",
        secondaryId: "globex_1",
        workspaceId: ACME,
      }),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    expect(await snapshotState()).toEqual(before);
  });

  it("answers 404 over HTTP for another tenant's id", async () => {
    const res = await request(app)
      .post("/api/contacts/merge")
      .set(asAcme())
      .send({ primaryId: "acme_1", secondaryId: "globex_1" });

    expect(res.status).toBe(404);
    // The message must not distinguish "missing" from "someone else's".
    expect(res.body.error).toBe("One or both records not found");

    const contacts = await query("SELECT id FROM contacts ORDER BY id");
    expect(contacts.rows.map((row) => row.id)).toEqual(["acme_1", "acme_2", "globex_1", "globex_2"]);
  });
});
