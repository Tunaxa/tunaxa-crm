import { describe, expect, it } from "vitest";

import { PG_RESOURCES, legacyToPg, pgToLegacy } from "../legacy-shape.js";

describe("PG_RESOURCES", () => {
  it("covers the core, revenue and 007 marketing/service resources", () => {
    // snake_case aliases are listed alongside the camelCase names the API uses
    // so the backfill script and migration tooling can look resources up by table
    // name. Both spellings have to be present or one of those callers silently
    // falls through to the JSON store.
    expect([...PG_RESOURCES].sort()).toEqual([
      "activities",
      "campaigns",
      "companies",
      "contacts",
      "contracts",
      "deals",
      "emailLists",
      "email_lists",
      "expenses",
      "forms",
      "goals",
      "invoices",
      "leads",
      "orders",
      "products",
      "quotes",
      "surveyResponses",
      "survey_responses",
      "surveys",
      "tasks",
      "tickets",
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

  // ── Revenue resources ─────────────────────────────────────────────────────
  // 006_revenue_tables.sql keys on TEXT and stores money as DOUBLE PRECISION.
  // The legacy store spells several of those columns differently, so these
  // tests pin the aliases the app depends on rather than the column names.

  describe("products", () => {
    it("maps the documented fields and keeps unlisted keys in the bag", () => {
      const out = legacyToPg(
        { name: "Starter Plan", sku: "ST-1", price: "49.99", cost: "10" },
        "products",
      );
      expect(out).toEqual({
        name: "Starter Plan",
        sku: "ST-1",
        price: "49.99",
        cost: "10",
      });
    });

    it("stores stock and minStock in the overflow bag and reads them back", () => {
      // routes/modules.js low-stock report reads these two off the record, so
      // they have to survive the round trip even though they are not columns.
      const body = { name: "Starter Plan", stock: "100", minStock: 5 };
      const out = legacyToPg(body, "products");
      expect(out.custom_fields).toEqual({ stock: "100", minStock: 5 });
      expect(pgToLegacy({ id: "p1", name: "Starter Plan", ...out }, "products")).toMatchObject({
        stock: "100",
        minStock: 5,
      });
    });

    it("serializes timestamps to ISO strings", () => {
      const out = pgToLegacy(
        {
          id: "p1",
          name: "Starter Plan",
          created_at: new Date("2026-01-02T03:04:05.000Z"),
          updated_at: new Date("2026-02-03T04:05:06.000Z"),
        },
        "products",
      );
      expect(out.createdAt).toBe("2026-01-02T03:04:05.000Z");
      expect(out.updatedAt).toBe("2026-02-03T04:05:06.000Z");
    });
  });

  describe("quotes", () => {
    it("renames the number, id and date columns", () => {
      const out = legacyToPg(
        {
          title: "Acme rollout",
          quoteNumber: "Q-1001",
          dealId: "deal-1",
          companyId: "company-1",
          contactId: "contact-1",
          expirationDate: "2026-12-31",
        },
        "quotes",
      );
      expect(out).toEqual({
        title: "Acme rollout",
        quote_number: "Q-1001",
        deal_id: "deal-1",
        company_id: "company-1",
        contact_id: "contact-1",
        expiration_date: "2026-12-31",
      });
    });

    it("accepts the bare `number` the portal seeds write", () => {
      expect(legacyToPg({ title: "X", number: "Q-9" }, "quotes").quote_number).toBe("Q-9");
    });

    it("accepts name and subject as the title", () => {
      expect(legacyToPg({ name: "From name" }, "quotes").title).toBe("From name");
      expect(legacyToPg({ subject: "From subject" }, "quotes").title).toBe("From subject");
    });

    it("falls back to the quote number when no title is provided", () => {
      // title is NOT NULL, so a legacy body keyed only on a number would fail
      // the insert with 23502 without this.
      expect(legacyToPg({ number: "Q-1001" }, "quotes").title).toBe("Q-1001");
    });

    it("falls back to customerEmail when neither title nor number exists", () => {
      expect(legacyToPg({ customerEmail: "cust@acme.com" }, "quotes").title).toBe(
        "cust@acme.com",
      );
    });

    it("prefers a supplied title over any fallback", () => {
      expect(legacyToPg({ title: "Real", number: "Q-1" }, "quotes").title).toBe("Real");
    });

    it("normalizes lineItems into the items array", () => {
      const out = legacyToPg({ title: "X", lineItems: [{ sku: "ST-1" }] }, "quotes");
      expect(out.items).toEqual([{ sku: "ST-1" }]);
    });

    it("wraps a bare object so the jsonb[] column never sees a scalar", () => {
      expect(legacyToPg({ title: "X", items: { sku: "ST-1" } }, "quotes").items).toEqual([
        { sku: "ST-1" },
      ]);
    });

    it("blanks an empty date instead of sending '' to timestamptz", () => {
      // PostgreSQL rejects '' for timestamptz with 22007.
      expect(legacyToPg({ title: "X", expirationDate: "" }, "quotes").expiration_date).toBeNull();
    });

    it("round-trips a quote", () => {
      const body = {
        title: "Acme rollout",
        quoteNumber: "Q-1001",
        total: 1500,
        status: "Sent",
        expirationDate: "2026-12-31",
        items: [{ sku: "ST-1", qty: 2 }],
      };
      const out = pgToLegacy(legacyToPg(body, "quotes"), "quotes");
      expect(out).toMatchObject({
        title: "Acme rollout",
        name: "Acme rollout",
        quoteNumber: "Q-1001",
        total: 1500,
        status: "Sent",
        expirationDate: "2026-12-31",
        items: [{ sku: "ST-1", qty: 2 }],
      });
    });
  });

  describe("contracts", () => {
    it("renames the number, id and date columns", () => {
      const out = legacyToPg(
        {
          title: "Acme MSA",
          contractNumber: "C-1",
          quoteId: "quote-1",
          startDate: "2026-01-01",
          endDate: "2027-01-01",
        },
        "contracts",
      );
      expect(out).toEqual({
        title: "Acme MSA",
        contract_number: "C-1",
        quote_id: "quote-1",
        start_date: "2026-01-01",
        end_date: "2027-01-01",
      });
    });

    it("falls back to the contract number when no title is provided", () => {
      expect(legacyToPg({ number: "C-1001" }, "contracts").title).toBe("C-1001");
    });

    it("accepts name as the title", () => {
      expect(legacyToPg({ name: "Acme deal" }, "contracts").title).toBe("Acme deal");
    });

    it("round-trips a contract", () => {
      const body = {
        name: "Acme deal",
        customerEmail: "cust@acme.com",
        status: "Active",
        value: 1500,
      };
      const out = pgToLegacy(legacyToPg(body, "contracts"), "contracts");
      expect(out).toMatchObject({
        title: "Acme deal",
        name: "Acme deal",
        status: "Active",
        value: 1500,
        customerEmail: "cust@acme.com",
      });
    });
  });

  describe("orders", () => {
    it("renames the number and id columns", () => {
      expect(
        legacyToPg(
          { orderNumber: "SO-1", quoteId: "quote-1", contractId: "contract-1" },
          "orders",
        ),
      ).toEqual({ order_number: "SO-1", quote_id: "quote-1", contract_id: "contract-1" });
    });

    it("maps the legacy `amount` alias onto the total column", () => {
      expect(legacyToPg({ amount: 1500 }, "orders").total).toBe(1500);
    });

    it("leaves total alone when both spellings are absent", () => {
      expect(legacyToPg({ orderNumber: "SO-1" }, "orders").total).toBeUndefined();
    });

    it("normalizes lineItems into the items array", () => {
      expect(legacyToPg({ lineItems: [{ sku: "ST-1" }] }, "orders").items).toEqual([
        { sku: "ST-1" },
      ]);
    });
  });

  describe("invoices", () => {
    it("maps the legacy `amount` onto the total column and reads it back as amount", () => {
      // routes/modules.js:70 sums `invoice.amount`, so that is the canonical
      // legacy key even though the column is `total`.
      const out = legacyToPg({ amount: 700 }, "invoices");
      expect(out.total).toBe(700);
      expect(pgToLegacy({ id: "inv-1", total: 700 }, "invoices").amount).toBe(700);
    });

    it("renames the number, id and date columns", () => {
      const out = legacyToPg(
        {
          invoiceNumber: "INV-P",
          orderId: "order-1",
          dueDate: "2026-04-01",
          paidAt: "2026-03-20T08:00:00.000Z",
        },
        "invoices",
      );
      expect(out).toEqual({
        invoice_number: "INV-P",
        order_id: "order-1",
        due_date: "2026-04-01",
        paid_at: "2026-03-20T08:00:00.000Z",
      });
    });

    it("serializes both timestamptz date columns to ISO strings", () => {
      const out = pgToLegacy(
        {
          id: "inv-1",
          total: 700,
          due_date: new Date("2026-04-01T00:00:00.000Z"),
          paid_at: new Date("2026-03-20T08:00:00.000Z"),
        },
        "invoices",
      );
      expect(out.dueDate).toBe("2026-04-01T00:00:00.000Z");
      expect(out.paidAt).toBe("2026-03-20T08:00:00.000Z");
    });

    it("round-trips the portal invoice shape", () => {
      const body = {
        number: "INV-P",
        customerEmail: "cust@acme.com",
        amount: 700,
        status: "Paid",
      };
      const out = pgToLegacy(legacyToPg(body, "invoices"), "invoices");
      expect(out).toMatchObject({
        invoiceNumber: "INV-P",
        amount: 700,
        status: "Paid",
        customerEmail: "cust@acme.com",
      });
    });
  });

  describe("expenses", () => {
    it("renames the id columns", () => {
      expect(legacyToPg({ title: "Cloud", userId: "user-1" }, "expenses")).toEqual({
        title: "Cloud",
        user_id: "user-1",
      });
    });

    it("falls back to the vendor when no title is provided", () => {
      expect(legacyToPg({ vendor: "Acme Cloud" }, "expenses").title).toBe("Acme Cloud");
    });

    it("accepts name as the title", () => {
      expect(legacyToPg({ name: "Cloud hosting" }, "expenses").title).toBe("Cloud hosting");
    });

    it("normalizes the date column for timestamptz", () => {
      expect(legacyToPg({ title: "Cloud", date: "2026-03-15" }, "expenses").date).toBe(
        "2026-03-15",
      );
    });

    it("round-trips an expense", () => {
      const body = { name: "Cloud hosting", category: "Infra", amount: 250.4 };
      const out = pgToLegacy(legacyToPg(body, "expenses"), "expenses");
      expect(out).toMatchObject({ title: "Cloud hosting", name: "Cloud hosting", amount: 250.4 });
    });
  });

  it("never lets a client pin the id or the timestamps", () => {
    for (const resource of ["products", "quotes", "contracts", "orders", "invoices", "expenses"]) {
      const out = legacyToPg({ id: "forced", createdAt: "x", updatedAt: "y" }, resource);
      expect(out.id).toBeUndefined();
      expect(out.created_at).toBeUndefined();
      expect(out.updated_at).toBeUndefined();
    }
  });
});
