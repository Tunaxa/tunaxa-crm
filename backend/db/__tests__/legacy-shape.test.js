import { describe, expect, it } from "vitest";

import { PG_RESOURCES, legacyToPg, pgToLegacy } from "../legacy-shape.js";

describe("PG_RESOURCES", () => {
  it("covers all six Postgres-backed resources", () => {
    expect([...PG_RESOURCES].sort()).toEqual([
      "activities",
      "companies",
      "contacts",
      "deals",
      "leads",
      "tasks",
    ]);
  });
});

describe("pgToLegacy", () => {
  it("returns null for a missing row", () => {
    expect(pgToLegacy(null, "companies")).toBeNull();
  });

  it("renames timestamps to camelCase ISO strings", () => {
    const created = new Date("2026-01-02T03:04:05.000Z");
    const updated = new Date("2026-02-03T04:05:06.000Z");

    expect(
      pgToLegacy(
        { id: "company-1", name: "Acme", created_at: created, updated_at: updated },
        "companies",
      ),
    ).toMatchObject({ createdAt: "2026-01-02T03:04:05.000Z", updatedAt: "2026-02-03T04:05:06.000Z" });
  });

  it("omits timestamps that are null instead of emitting the string null", () => {
    const out = pgToLegacy({ id: "company-1", created_at: null }, "companies");
    expect("createdAt" in out).toBe(false);
  });

  it("hides workspace_id, the overflow bag and activities metadata", () => {
    const companies = pgToLegacy(
      { id: "company-1", workspace_id: "default", custom_fields: { region: "emea" }, name: "Acme" },
      "companies",
    );
    expect(companies).not.toHaveProperty("workspace_id");
    expect(companies).not.toHaveProperty("custom_fields");
    expect(companies.region).toBe("emea");

    const activities = pgToLegacy(
      { id: "activity-1", metadata: { campaign: "spring" }, type: "Email" },
      "activities",
    );
    expect(activities).not.toHaveProperty("metadata");
  });

  describe("companies", () => {
    it("maps the documented fields", () => {
      const out = pgToLegacy(
        {
          id: "company-1",
          name: "Acme",
          domain: "acme.example",
          industry: "Technology",
        },
        "companies",
      );
      expect(out).toEqual({
        id: "company-1",
        name: "Acme",
        domain: "acme.example",
        industry: "Technology",
      });
    });
  });

  describe("deals", () => {
    it("maps title, value, stage, the relational pointers and the close date", () => {
      const out = pgToLegacy(
        {
          id: "deal-1",
          title: "Expansion",
          value: 12345.5,
          stage: "new",
          pipeline_id: "pipeline-1",
          company_id: "company-1",
          contact_id: "contact-1",
          expected_close_date: new Date("2026-12-31T00:00:00.000Z"),
        },
        "deals",
      );
      expect(out).toEqual({
        id: "deal-1",
        title: "Expansion",
        name: "Expansion",
        value: 12345.5,
        stage: "new",
        pipelineId: "pipeline-1",
        companyId: "company-1",
        contactId: "contact-1",
        closeDate: "2026-12-31T00:00:00.000Z",
      });
    });
  });

  describe("tasks", () => {
    it("maps dueDate, completed and assignedTo", () => {
      const out = pgToLegacy(
        {
          id: "task-1",
          title: "Follow up",
          completed: false,
          due_date: new Date("2026-10-01T00:00:00.000Z"),
          assigned_to: "user-1",
        },
        "tasks",
      );
      expect(out).toEqual({
        id: "task-1",
        title: "Follow up",
        completed: false,
        dueDate: "2026-10-01T00:00:00.000Z",
        assignedTo: "user-1",
      });
    });
  });

  describe("activities", () => {
    it("maps type, subject, description and the entity pointer", () => {
      const out = pgToLegacy(
        {
          id: "activity-1",
          type: "Email",
          subject: "Re: pricing",
          description: "Sent an email",
          entity_type: "contact",
          entity_id: "contact-1",
        },
        "activities",
      );
      expect(out).toEqual({
        id: "activity-1",
        type: "Email",
        subject: "Re: pricing",
        description: "Sent an email",
        notes: "Sent an email",
        entityType: "contact",
        entityId: "contact-1",
      });
    });

    it("keeps notes alongside description because the timeline reads notes", () => {
      const out = pgToLegacy(
        { id: "activity-1", description: "Called back" },
        "activities",
      );
      expect(out.notes).toBe("Called back");
      expect(out.description).toBe("Called back");
    });

    it("maps record_id to recordId", () => {
      const out = pgToLegacy(
        { id: "activity-1", record_id: "lead-1" },
        "activities",
      );
      expect(out.recordId).toBe("lead-1");
      expect(out).not.toHaveProperty("record_id");
    });
  });

  it("merges the overflow bag but never lets it shadow a real column", () => {
    const out = pgToLegacy(
      {
        id: "activity-1",
        type: "Email",
        // A bag entry trying to overwrite a real column must lose.
        custom_fields: { type: "spoofed", callId: "call-1", date: "2026-01-01" },
      },
      "activities",
    );
    expect(out.type).toBe("Email");
    expect(out.callId).toBe("call-1");
    expect(out.date).toBe("2026-01-01");
    expect(out).not.toHaveProperty("custom_fields");
  });

  it("ignores a non-object overflow bag", () => {
    const out = pgToLegacy({ id: "activity-1", custom_fields: null }, "activities");
    expect(out).toEqual({ id: "activity-1" });
  });

  describe("contacts and leads (no mapping entry)", () => {
    it("keeps rebuilding name from first_name and last_name", () => {
      const created = new Date("2026-01-02T03:04:05.000Z");
      expect(
        pgToLegacy(
          {
            id: "contact-1",
            first_name: "Ada",
            last_name: "Lovelace",
            email: "ada@example.com",
            created_at: created,
            workspace_id: "default",
          },
          "contacts",
        ),
      ).toEqual({
        id: "contact-1",
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
        name: "Ada Lovelace",
        createdAt: "2026-01-02T03:04:05.000Z",
        workspace_id: "default",
      });
    });

    it("keeps working when no resource is passed at all", () => {
      expect(pgToLegacy({ id: "lead-1", first_name: "Ada" }).name).toBe("Ada");
    });
  });
});

describe("legacyToPg", () => {
  it("returns an empty object for a missing body", () => {
    expect(legacyToPg(undefined, "companies")).toEqual({});
  });

  it("drops the id and the client-supplied timestamps", () => {
    const out = legacyToPg(
      { id: "company-1", name: "Acme", createdAt: "2020-01-01", updatedAt: "2020-01-01" },
      "companies",
    );
    expect(out).toEqual({ name: "Acme" });
  });

  it("keeps unknown legacy fields in the overflow bag so they round-trip", () => {
    const out = pgToLegacy(
      legacyToPg(
        { name: "Acme", region: "emea", renewalDate: "2026-05-01" },
        "companies",
      ),
      "companies",
    );
    expect(out.region).toBe("emea");
    expect(out.renewalDate).toBe("2026-05-01");
  });

  it("leaves custom_fields unset when the bag is empty so a PUT does not wipe it", () => {
    expect(legacyToPg({ name: "Acme" }, "companies")).toEqual({ name: "Acme" });
  });

  it("folds an explicit custom_fields object into the bag", () => {
    const out = legacyToPg(
      { name: "Acme", region: "emea", custom_fields: { tier: "gold" } },
      "companies",
    );
    expect(out).toEqual({ name: "Acme", custom_fields: { region: "emea", tier: "gold" } });
  });

  it("ignores a non-object custom_fields", () => {
    expect(legacyToPg({ name: "Acme", custom_fields: "nope" }, "companies")).toEqual({
      name: "Acme",
    });
  });

  describe("companies", () => {
    it("routes name, domain and industry to their columns", () => {
      expect(
        legacyToPg(
          { name: "Acme", domain: "acme.example", industry: "Technology" },
          "companies",
        ),
      ).toEqual({ name: "Acme", domain: "acme.example", industry: "Technology" });
    });
  });

  describe("deals", () => {
    it("routes title, value, stage and the relational pointers to their columns", () => {
      expect(
        legacyToPg(
          {
            title: "Expansion",
            value: 12345.5,
            stage: "new",
            pipelineId: "pipeline-1",
            companyId: "company-1",
            contactId: "contact-1",
          },
          "deals",
        ),
      ).toEqual({
        title: "Expansion",
        value: 12345.5,
        stage: "new",
        pipeline_id: "pipeline-1",
        company_id: "company-1",
        contact_id: "contact-1",
      });
    });

    it("accepts name and closeDate as aliases and answers with both", () => {
      const pg = legacyToPg(
        { name: "Expansion", closeDate: "2026-12-31" },
        "deals",
      );
      expect(pg).toEqual({ title: "Expansion", expected_close_date: "2026-12-31" });

      const out = pgToLegacy(
        { id: "deal-1", ...pg, expected_close_date: "2026-12-31" },
        "deals",
      );
      expect(out.title).toBe("Expansion");
      expect(out.name).toBe("Expansion");
      expect(out.closeDate).toBe("2026-12-31");
    });
  });

  describe("tasks", () => {
    it("routes dueDate, completed and assignedTo to their columns", () => {
      expect(
        legacyToPg(
          { title: "Follow up", dueDate: "2026-10-01", completed: false, assignedTo: "user-1" },
          "tasks",
        ),
      ).toEqual({
        title: "Follow up",
        due_date: "2026-10-01",
        completed: false,
        assigned_to: "user-1",
      });
    });

    it("accepts notes as an alias for the description column", () => {
      expect(legacyToPg({ title: "Follow up", notes: "Call back" }, "tasks")).toEqual({
        title: "Follow up",
        description: "Call back",
      });
    });
  });

  describe("activities", () => {
    it("routes the documented fields to their columns", () => {
      expect(
        legacyToPg(
          {
            type: "Email",
            subject: "Re: pricing",
            description: "Sent an email",
            entityType: "contact",
            entityId: "contact-1",
          },
          "activities",
        ),
      ).toEqual({
        type: "Email",
        subject: "Re: pricing",
        description: "Sent an email",
        entity_type: "contact",
        entity_id: "contact-1",
      });
    });

    it("accepts notes and recordId as aliases", () => {
      expect(
        legacyToPg(
          { type: "Note", notes: "Called back", recordId: "lead-1" },
          "activities",
        ),
      ).toEqual({ type: "Note", description: "Called back", record_id: "lead-1" });
    });

    it("keeps timeline fields the timeline filters on as real columns", () => {
      const out = legacyToPg(
        { title: "Email event", type: "Email", contact: "AXA-97" },
        "activities",
      );
      expect(out).toEqual({ title: "Email event", type: "Email", contact: "AXA-97" });
    });
  });

  it("round-trips the activity shape the timeline test writes", () => {
    const body = {
      title: "Lifecycle event",
      type: "Lifecycle",
      contact: "AXA-97 Filter Target",
      date: "2026-01-01",
      notes: "Moved to lifecycle stage",
    };
    expect(pgToLegacy(legacyToPg(body, "activities"), "activities")).toEqual({
      title: "Lifecycle event",
      type: "Lifecycle",
      contact: "AXA-97 Filter Target",
      description: "Moved to lifecycle stage",
      notes: "Moved to lifecycle stage",
      date: "2026-01-01",
    });
  });

  describe("contacts and leads (no mapping entry)", () => {
    it("keeps splitting name into first_name and last_name", () => {
      expect(legacyToPg({ name: "Ada Lovelace", email: "ada@example.com" })).toEqual({
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
      });
    });

    it("keeps sending a single-word name through as an empty last_name", () => {
      expect(legacyToPg({ name: "Ada" })).toEqual({ first_name: "Ada", last_name: undefined });
    });
  });
});
