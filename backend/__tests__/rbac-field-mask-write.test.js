// Write-side RBAC field masking.
//
// The read-side engine (permissions.js → applyFieldMasking) only ever edited
// responses, so a masked field was protected on the way out and completely open
// on the way in. These tests assert the missing half: a write that touches a
// masked field is refused with 403 *and* leaves the stored row byte-identical.
//
// "Byte-identical" is the part that matters. A 403 with a partial write behind it
// is not a control, so every rejection case re-reads the record from PostgreSQL
// and compares it against the pre-request snapshot rather than trusting the
// status code.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { resetTestDb, cleanupTestDb } from "./setup.js";
import { mutateDb } from "../store.js";
import { query } from "../db/pg.js";
import {
  validateWriteFieldPermissions,
  submittedFieldKeys,
  maskedFieldsForRole,
  normalizeFieldKey,
  objectTypeOf,
} from "../routes/permissions.js";

let app;
const tokens = { admin: "", member: "", viewer: "" };
const ACME = "ws_rbac_mask";

// Seeded ids, so every assertion can name the row it means.
const CONTACT = "cnt_mask_target";
const DEAL = "deal_mask_target";

function makePassword() {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync("test123", salt, 64).toString("hex")}`;
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

const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

/** The whole contact row, exactly as PostgreSQL holds it. */
async function readContact(id = CONTACT) {
  const result = await query("SELECT * FROM contacts WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function readDeal(id = DEAL) {
  const result = await query("SELECT * FROM deals WHERE id = $1", [id]);
  return result.rows[0] || null;
}

beforeAll(async () => {
  await resetTestDb();

  const mod = await import("../server.js");
  app = mod.app;

  await mutateDb((db) => {
    for (const [id, email, role] of [
      ["usr_mask_admin", "maskadmin@test.com", "admin"],
      ["usr_mask_member", "maskmember@test.com", "member"],
      ["usr_mask_viewer", "maskviewer@test.com", "viewer"],
    ]) {
      db.users.unshift({
        id,
        name: email.split("@")[0],
        email,
        password: makePassword(),
        role,
        workspaceId: ACME,
        createdAt: new Date().toISOString(),
      });
    }

    // The configuration under test. `phone` and `title` are real contacts
    // columns; `ssn` and `internalNotes` are not, so both land in the
    // custom_fields overflow bag - which is how the read side surfaces them too.
    db.fieldPermissions = {
      contact: {
        member: { visible: null, hidden: ["phone", "title", "ssn", "internalNotes"] },
        viewer: { visible: null, hidden: ["phone", "title", "ssn", "internalNotes"] },
      },
      deal: {
        member: { visible: null, hidden: ["commission", "internalNotes"] },
        viewer: { visible: null, hidden: ["commission", "internalNotes"] },
      },
      ticket: {
        member: { visible: null, hidden: ["commission"] },
        viewer: { visible: null, hidden: ["commission"] },
      },
    };
  });

  tokens.admin = await seedSession("usr_mask_admin");
  tokens.member = await seedSession("usr_mask_member");
  tokens.viewer = await seedSession("usr_mask_viewer");

  await query(
    `INSERT INTO contacts (id, workspace_id, first_name, last_name, email, phone, custom_fields)
     VALUES ($1, $2, 'Jane', 'Original', 'jane@acme.com', '+1-555-0100', '{"ssn":"111-11-1111","internalNotes":"Original margin data","region":"west"}')`,
    [CONTACT, ACME],
  );
  await query(
    `INSERT INTO deals (id, workspace_id, title, contact_id, value, custom_fields)
     VALUES ($1, $2, 'Masked deal', $3, 42000, '{"commission":"12%","internalNotes":"Original margin data"}')`,
    [DEAL, ACME, CONTACT],
  );
});

afterAll(() => cleanupTestDb());

// ===========================================================================
describe("Write field mask: key normalization", () => {
  it("folds casing and underscore spelling onto one key", () => {
    expect(normalizeFieldKey("internalNotes")).toBe("internal_notes");
    expect(normalizeFieldKey("internal_notes")).toBe("internal_notes");
    expect(normalizeFieldKey("Internal Notes")).toBe("internal_notes");
    expect(normalizeFieldKey("Phone")).toBe("phone");
    expect(normalizeFieldKey("")).toBe("");
  });

  it("expands a customFields bag to its contents, not the container", () => {
    // The container must not appear as a field name: `custom_fields` is on every
    // legacy write, so treating it as a field would mask the whole resource.
    expect([...submittedFieldKeys({ customFields: { internalNotes: "x" } })]).toEqual([
      "internal_notes",
    ]);
    expect([...submittedFieldKeys({ custom_fields: { tier: "gold" } })]).toEqual(["tier"]);
    expect([...submittedFieldKeys({ firstName: "A" })]).toEqual(["first_name"]);
  });

  it("counts a field as submitted whatever its value", () => {
    for (const value of [null, 0, false, "", "x"]) {
      expect([...submittedFieldKeys({ phone: value })]).toEqual(["phone"]);
    }
  });

  it("treats an absent bag and a non-object payload as nothing to check", () => {
    expect(submittedFieldKeys({}).size).toBe(0);
    expect(submittedFieldKeys(null).size).toBe(0);
    expect(submittedFieldKeys([{ phone: "x" }]).size).toBe(0);
    expect(submittedFieldKeys({ customFields: "nope" }).size).toBe(0);
    expect(submittedFieldKeys({ customFields: { a: undefined } }).size).toBe(0);
  });

  it("normalizes a configured hidden list and tolerates junk in it", () => {
    expect([...maskedFieldsForRole({ hiddenFields: ["firstName", "SSN"] })].sort()).toEqual([
      "first_name",
      "ssn",
    ]);
    expect(maskedFieldsForRole(null).size).toBe(0);
    expect(maskedFieldsForRole({ hiddenFields: "nope" }).size).toBe(0);
    expect(maskedFieldsForRole({ hiddenFields: [null, ""] }).size).toBe(0);
  });

  it("resolves the singular object type both route families use", () => {
    expect(objectTypeOf("contacts")).toBe("contact");
    expect(objectTypeOf("deals")).toBe("deal");
    expect(objectTypeOf("contact")).toBe("contact");
    expect(objectTypeOf(undefined)).toBe(null);
  });
});

// ===========================================================================
describe("validateWriteFieldPermissions", () => {
  const perms = { visibleFields: null, hiddenFields: ["phone", "internal_notes"] };

  it("allows an admin regardless of the configuration", async () => {
    const check = await validateWriteFieldPermissions({
      user: { role: "admin" },
      resource: "contacts",
      data: { phone: "x" },
      fieldPerms: perms,
    });
    expect(check.allowed).toBe(true);
    expect(check.maskedFields).toEqual([]);
  });

  it("treats Owner as admin, matching requireRole", async () => {
    for (const role of ["Owner", "owner"]) {
      const check = await validateWriteFieldPermissions({
        user: { role },
        resource: "contacts",
        data: { phone: "x" },
        fieldPerms: perms,
      });
      expect(check.allowed).toBe(true);
    }
  });

  it("allows a write that avoids every masked field", async () => {
    const check = await validateWriteFieldPermissions({
      user: { role: "member" },
      resource: "contacts",
      data: { firstName: "Updated" },
      fieldPerms: perms,
    });
    expect(check.allowed).toBe(true);
  });

  it("catches a masked field sent in a different spelling", async () => {
    // Configured `internal_notes`, sent as `internalNotes`: comparing raw strings
    // would let this through.
    const check = await validateWriteFieldPermissions({
      user: { role: "member" },
      resource: "contacts",
      data: { customFields: { internalNotes: "leak" } },
      fieldPerms: perms,
    });
    expect(check.allowed).toBe(false);
    expect(check.maskedFields).toEqual(["internal_notes"]);
  });

  it("reports the configured spelling and de-duplicates", async () => {
    const check = await validateWriteFieldPermissions({
      user: { role: "member" },
      resource: "contacts",
      data: { phone: "a", Phone: "b", customFields: { internal_notes: "c" } },
      fieldPerms: perms,
    });
    expect(check.allowed).toBe(false);
    expect(check.maskedFields).toEqual(["internal_notes", "phone"]);
  });

  it("ignores server-owned metadata fields", async () => {
    // `partialDelta()` drops these and the tenant is derived from the session,
    // so refusing them would advertise a boundary that does not exist.
    const check = await validateWriteFieldPermissions({
      user: { role: "member" },
      resource: "contacts",
      data: { id: "hacked", workspaceId: "other", createdAt: "1999", updatedAt: "1999" },
      fieldPerms: perms,
    });
    expect(check.allowed).toBe(true);
  });

  it("allows everything when the role has no configured entry", async () => {
    const check = await validateWriteFieldPermissions({
      user: { role: "member" },
      resource: "leads",
      data: { anything: "x" },
      fieldPerms: null,
    });
    expect(check.allowed).toBe(true);
  });
});

// ===========================================================================
describe("PATCH /api/contacts/:id — masked top-level field", () => {
  it("403s and leaves phone untouched", async () => {
    const before = await readContact();

    const res = await request(app)
      .patch(`/api/contacts/${CONTACT}`)
      .set(as("member"))
      .send({ phone: "+1-555-9999" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden: Cannot write to masked field(s)");
    expect(res.body.maskedFields).toEqual(["phone"]);

    const after = await readContact();
    expect(after.phone).toBe("+1-555-0100");
    expect(after.phone).toBe(before.phone);
    expect(after).toEqual(before);
  });

  it("403s a masked value of any type, including null", async () => {
    const before = await readContact();
    for (const value of [null, 0, false, ""]) {
      const res = await request(app)
        .patch(`/api/contacts/${CONTACT}`)
        .set(as("member"))
        .send({ phone: value });
      expect(res.status).toBe(403);
    }
    expect(await readContact()).toEqual(before);
  });

  it("403s a masked field spelled in snake_case", async () => {
    const before = await readContact();
    const res = await request(app)
      .patch(`/api/contacts/${CONTACT}`)
      .set(as("member"))
      // contacts predate RESOURCE_MAPPINGS, so both spellings reach the row.
      .send({ Phone: "+1-555-9999" });
    expect(res.status).toBe(403);
    expect(await readContact()).toEqual(before);
  });
});

// ===========================================================================
describe("PATCH /api/contacts/:id — masked field inside a partial update", () => {
  // `first_name`, not `firstName`: contacts predate RESOURCE_MAPPINGS, so
  // genericLegacyToPg() passes the body through untranslated and the repository
  // allowlist is snake_case. A camelCase key is not an updatable column, so the
  // request would 404 on "nothing to do" and the assertion below would prove
  // nothing about masking.
  it("persists neither the allowed field nor the masked one", async () => {
    const before = await readContact();

    const res = await request(app)
      .patch(`/api/contacts/${CONTACT}`)
      .set(as("member"))
      .send({ first_name: "UpdatedName", ssn: "000-00-0000" });

    expect(res.status).toBe(403);
    expect(res.body.maskedFields).toEqual(["ssn"]);

    const after = await readContact();
    // first_name was allowed, but the request as a whole is refused, so it must
    // not be applied either: a half-applied PATCH is its own corruption.
    expect(after.first_name).toBe("Jane");
    expect(after.first_name).toBe(before.first_name);
    expect(after.custom_fields.ssn).toBe("111-11-1111");
    expect(after).toEqual(before);
  });

  it("403s a masked custom field nested in a customFields bag", async () => {
    const before = await readContact();

    const res = await request(app)
      .patch(`/api/contacts/${CONTACT}`)
      .set(as("member"))
      .send({ customFields: { internalNotes: "Confidential margin data" } });

    expect(res.status).toBe(403);
    expect(res.body.maskedFields).toEqual(["internalNotes"]);

    const after = await readContact();
    expect(after.custom_fields.internalNotes).toBe("Original margin data");
    expect(after).toEqual(before);
  });

  it("allows an unmasked custom field, and does not treat the bag as masked", async () => {
    // The container must not be what is forbidden. deals is used here because it
    // is a mapped resource: `custom_fields` reaches the allowlist, whereas on
    // contacts `partialDelta()` flattens the bag to a bare key that no
    // repository allowlist contains (a separate pre-existing defect - see the
    // report - which has nothing to do with masking).
    const res = await request(app)
      .patch(`/api/deals/${DEAL}`)
      .set(as("member"))
      .send({ tier: "gold" });

    expect(res.status).toBe(200);
    const after = await readDeal();
    expect(after.custom_fields.tier).toBe("gold");
    // The masked keys in the same bag are untouched by an allowed write.
    expect(after.custom_fields.commission).toBe("12%");
    expect(after.custom_fields.internalNotes).toBe("Original margin data");
  });

  it("does not treat a customFields container itself as a masked field", async () => {
    // Whatever the outcome of the write, it must not be a 403 for the container.
    const bag = await request(app)
      .patch(`/api/deals/${DEAL}`)
      .set(as("member"))
      .send({ customFields: { tier: "platinum" } });
    expect(bag.status).not.toBe(403);

    const nested = await request(app)
      .patch(`/api/deals/${DEAL}`)
      .set(as("member"))
      .send({ custom_fields: { region: "north" } });
    expect(nested.status).not.toBe(403);
  });
});

// ===========================================================================
describe("PUT /api/deals/:id — masked field", () => {
  it("403s a masked commission and leaves custom_fields untouched", async () => {
    const before = await readDeal();

    const res = await request(app)
      .put(`/api/deals/${DEAL}`)
      .set(as("member"))
      .send({ title: "Renamed deal", customFields: { commission: "40%" } });

    expect(res.status).toBe(403);
    expect(res.body.maskedFields).toEqual(["commission"]);

    const after = await readDeal();
    expect(after.title).toBe("Masked deal");
    expect(after.custom_fields.commission).toBe("12%");
    expect(after).toEqual(before);
  });

  it("403s a masked custom field supplied at the top level", async () => {
    // The legacy shape is flat: partialDelta() lifts the bag and pgToLegacy()
    // flattens it back out, so a custom field arrives bare at least as often as
    // it arrives nested. Both spellings have to be refused.
    const before = await readDeal();
    const res = await request(app)
      .put(`/api/deals/${DEAL}`)
      .set(as("member"))
      .send({ internalNotes: "Confidential margin data" });

    expect(res.status).toBe(403);
    expect(res.body.maskedFields).toEqual(["internalNotes"]);
    expect(await readDeal()).toEqual(before);
  });
});

// ===========================================================================
describe("POST /api/:resource — masked field on create", () => {
  it("403s and creates nothing", async () => {
    const countBefore = await query("SELECT COUNT(*)::int AS n FROM contacts");

    const res = await request(app)
      .post("/api/contacts")
      .set(as("member"))
      .send({ name: "New Person", phone: "+1-555-7777" });

    expect(res.status).toBe(403);
    expect(res.body.maskedFields).toEqual(["phone"]);

    const countAfter = await query("SELECT COUNT(*)::int AS n FROM contacts");
    expect(countAfter.rows[0].n).toBe(countBefore.rows[0].n);
  });

  it("allows a create with no masked field", async () => {
    const res = await request(app)
      .post("/api/contacts")
      .set(as("member"))
      .send({ name: "New Person", email: "new.person@acme.com" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.email).toBe("new.person@acme.com");
    expect(res.body.first_name).toBe("New");
  });
});

// ===========================================================================
describe("POST /api/:resource/batch — per element, not per request", () => {
  it("403s the whole batch when any element is masked", async () => {
    const before = await query("SELECT COUNT(*)::int AS n FROM contacts");

    const res = await request(app)
      .post("/api/contacts/batch")
      .set(as("member"))
      .send([
        { name: "Clean One" },
        { name: "Masked Two", phone: "+1-555-4444" },
      ]);

    expect(res.status).toBe(403);
    expect(res.body.maskedFields).toEqual(["phone"]);

    // Neither element landed: a batch must not become a way to commit the clean
    // rows while the masked one is dropped.
    const after = await query("SELECT COUNT(*)::int AS n FROM contacts");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

// ===========================================================================
describe("Allowed writes and the admin bypass", () => {
  it("lets a restricted role update a permitted field", async () => {
    const res = await request(app)
      .patch(`/api/contacts/${CONTACT}`)
      .set(as("member"))
      .send({ first_name: "ValidName" });

    expect(res.status).toBe(200);
    expect(res.body.first_name).toBe("ValidName");
    const row = await readContact();
    expect(row.first_name).toBe("ValidName");
    expect(row.phone).toBe("+1-555-0100");
  });

  it("lets an admin write a masked field", async () => {
    const before = await readContact();

    const res = await request(app)
      .patch(`/api/contacts/${CONTACT}`)
      .set(as("admin"))
      .send({ phone: "+1-555-0300" });

    expect(res.status).toBe(200);
    const row = await readContact();
    expect(row.phone).toBe("+1-555-0300");
    expect(row.phone).not.toBe(before.phone);

    await request(app)
      .patch(`/api/contacts/${CONTACT}`)
      .set(as("admin"))
      .send({ phone: "+1-555-0100" });
  });

  it("lets an admin create a record carrying a masked field", async () => {
    const res = await request(app)
      .post("/api/contacts")
      .set(as("admin"))
      .send({ name: "Admin Created", phone: "+1-555-1234" });

    expect(res.status).toBe(201);
    expect(res.body.phone).toBe("+1-555-1234");
  });

  it("still refuses a viewer on role grounds, before any field check", async () => {
    // A viewer cannot write at all, so requireRole answers first. Worth pinning:
    // it proves the 403 for a masked field is a field decision, not a role one.
    const before = await readContact();
    const res = await request(app)
      .patch(`/api/contacts/${CONTACT}`)
      .set(as("viewer"))
      .send({ first_name: "Nope" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden: insufficient permissions");
    expect(res.body.maskedFields).toBeUndefined();
    expect(await readContact()).toEqual(before);
  });
});

// ===========================================================================
describe("Masking is scoped per object type", () => {
  it("refuses a contact field the contact mask lists", async () => {
    // `title` is masked on contact...
    const before = await readContact();
    const res = await request(app)
      .patch(`/api/contacts/${CONTACT}`)
      .set(as("member"))
      .send({ title: "VP Sales" });

    expect(res.status).toBe(403);
    expect(res.body.maskedFields).toEqual(["title"]);
    expect(await readContact()).toEqual(before);
  });

  it("allows the very same field on a deal, whose mask does not list it", async () => {
    // ...and is not masked on deal. If the check resolved the wrong object type
    // key, or leaked across resources, this write would be refused too.
    const res = await request(app)
      .patch(`/api/deals/${DEAL}`)
      .set(as("member"))
      .send({ title: "Deal title allowed" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Deal title allowed");
  });
});

// ===========================================================================
describe("Second generic write API is not a bypass", () => {
  it("403s a masked field through /api/v1/objects", async () => {
    const before = await readContact();
    const res = await request(app)
      .patch(`/api/v1/objects/contact/${CONTACT}`)
      .set(as("member"))
      .send({ phone: "+1-555-5555" });

    expect(res.status).toBe(403);
    expect(res.body.maskedFields).toEqual(["phone"]);
    expect(await readContact()).toEqual(before);
  });

  it("403s a masked field through the v1 batch endpoint", async () => {
    const res = await request(app)
      .post("/api/v1/objects/contact/batch/update")
      .set(as("member"))
      .send([{ id: CONTACT, phone: "+1-555-6666" }]);

    expect(res.status).toBe(403);
    expect(res.body.maskedFields).toEqual(["phone"]);
    expect((await readContact()).phone).toBe("+1-555-0100");
  });
});

// ===========================================================================
describe("POST /api/:resource/merge — fieldOverrides", () => {
  // A merge is not a `POST /api/contacts` request, but `fieldOverrides` writes
  // the very same columns on the very same records. Leaving it unguarded would
  // mean the control could be stepped around with one URL.
  it("refuses a merge that overrides a masked field, and merges nothing", async () => {
    const before = await readContact();
    const dup = await query(
      `INSERT INTO contacts (id, workspace_id, first_name, last_name, email)
       VALUES ('cnt_mask_dup', $1, 'Jim', 'Duplicate', 'jim@acme.com')
       RETURNING id`,
      [ACME],
    );
    expect(dup.rows).toHaveLength(1);

    const res = await request(app)
      .post("/api/contacts/merge")
      .set(as("member"))
      .send({
        primaryId: CONTACT,
        secondaryId: "cnt_mask_dup",
        fieldOverrides: { phone: "+1-555-9999" },
      });

    expect(res.status).toBe(403);
    expect(res.body.maskedFields).toEqual(["phone"]);

    // No transaction ran: both rows survive and neither was rewritten.
    expect(await readContact()).toEqual(before);
    const survivor = await query("SELECT id FROM contacts WHERE id = 'cnt_mask_target'");
    expect(survivor.rows).toHaveLength(1);
    const duplicate = await query("SELECT id FROM contacts WHERE id = 'cnt_mask_dup'");
    expect(duplicate.rows).toHaveLength(1);

    await query("DELETE FROM contacts WHERE id = 'cnt_mask_dup'");
  });

  it("does not treat the merge wrapper keys as masked fields", async () => {
    // `fieldOverrides` itself is not a field on a contact. A check that read the
    // whole body would either miss the real override or refuse on the wrapper.
    const res = await request(app)
      .post("/api/contacts/merge")
      .set(as("member"))
      .send({
        primaryId: CONTACT,
        secondaryId: "cnt_mask_dup",
        fieldOverrides: { region: "east" },
      });

    expect(res.status).not.toBe(403);
  });
});

describe("Dedicated route handlers", () => {
  it("403s a masked field on POST /api/tickets", async () => {
    const before = await query("SELECT COUNT(*)::int AS n FROM tickets");
    const res = await request(app)
      .post("/api/tickets")
      .set(as("member"))
      .send({ subject: "Masked ticket", commission: "40%" });

    expect(res.status).toBe(403);
    expect(res.body.maskedFields).toEqual(["commission"]);
    const after = await query("SELECT COUNT(*)::int AS n FROM tickets");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("still allows a ticket with no masked field", async () => {
    const res = await request(app)
      .post("/api/tickets")
      .set(as("member"))
      .send({ subject: "Clean ticket" });

    expect(res.status).toBe(201);
  });
});