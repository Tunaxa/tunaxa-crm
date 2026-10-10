// ---------- PG ↔ legacy-JSON shape adapters ----------
// The REST API surface and test suite use the legacy flat schema:
//   { id, name, email, phone, status, value, createdAt, updatedAt, ... }
// The PG repositories use snake_case column names.
// These helpers translate in both directions so all existing callers
// continue to work unchanged.
//
// Pure functions with no dependencies, so both route modules can share them
// without importing each other.

/**
 * Resources whose rows live in Postgres rather than the JSON store. Both the
 * write path (routes/resources.js) and the read path that duplicate detection
 * depends on (routes/dataops.js) must agree on this set; keeping one copy here
 * is what stops the two from drifting apart again.
 */
export const PG_RESOURCES = new Set([
  "contacts",
  "leads",
  "companies",
  "deals",
  "tasks",
  "activities",
  "products",
  "quotes",
  "contracts",
  "orders",
  "invoices",
  "expenses",
  "campaigns",
  "emailLists",
  "email_lists",
  "forms",
  "tickets",
  "surveys",
  "surveyResponses",
  "survey_responses",
]);

/**
 * Per-resource column knowledge for the four core entities.
 *
 * `columns` is the authoritative column list for the table (see
 * migrations/005_core_entities.sql). It is what decides whether an incoming
 * field becomes a real column or an entry in the custom_fields overflow bag:
 *
 *   - a key in `columns` is stored in that column, so it stays queryable,
 *     sortable and indexable;
 *   - anything else (activity `date`/`callId`/`messageId`/`workflowId`, custom
 *     fields, ...) is stored in `custom_fields` and merged back out on read, so
 *     the flat legacy record survives the round trip without a migration per
 *     field the app happens to write somewhere.
 *
 * `toPg` / `toLegacy` are the renames between the legacy camelCase key and the
 * column name. `hidden` columns are stored but never exposed in a response.
 */
// Exported so a test can assert that every mapped column still exists in the
// table (and the other way round) after a migration. That drift is otherwise
// invisible until a request happens to touch the offending column.
export const RESOURCE_MAPPINGS = {
  companies: {
    columns: [
      "workspace_id",
      "name",
      "domain",
      "industry",
      "website",
      "country",
      "size",
      "employees",
      "owner",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: { createdAt: "created_at", updatedAt: "updated_at" },
    toLegacy: { created_at: "createdAt", updated_at: "updatedAt" },
    hidden: ["workspace_id", "custom_fields"],
  },
  deals: {
    columns: [
      "workspace_id",
      "title",
      "company",
      "company_id",
      "contact",
      "contact_id",
      "pipeline_id",
      "owner",
      "owner_id",
      "value",
      "stage",
      "expected_close_date",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    // `name` is the deal name; `title` is the column and the legacy key.
    // Accepting `name` on write keeps CSV import and older clients working.
    toPg: {
      name: "title",
      companyId: "company_id",
      contactId: "contact_id",
      pipelineId: "pipeline_id",
      closeDate: "expected_close_date",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      company_id: "companyId",
      contact_id: "contactId",
      pipeline_id: "pipelineId",
      expected_close_date: "closeDate",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
    extraLegacy: { title: "name" },
  },
  tasks: {
    columns: [
      "workspace_id",
      "title",
      "description",
      "status",
      "completed",
      "priority",
      "owner",
      "assigned_to",
      "due_date",
      "source",
      "contact_id",
      "deal_id",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: {
      notes: "description",
      dueDate: "due_date",
      assignedTo: "assigned_to",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      due_date: "dueDate",
      assigned_to: "assignedTo",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
  },
  activities: {
    columns: [
      "workspace_id",
      "type",
      "title",
      "subject",
      "description",
      "contact",
      "company",
      "direction",
      "record_id",
      "entity_type",
      "entity_id",
      "user_id",
      "contact_id",
      "deal_id",
      "metadata",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    // `notes` is the legacy name for the description text, and `recordId` the
    // legacy name for the entity pointer.
    toPg: {
      notes: "description",
      recordId: "record_id",
      entityType: "entity_type",
      entityId: "entity_id",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      record_id: "recordId",
      entity_type: "entityType",
      entity_id: "entityId",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields", "metadata"],
    // The timeline UI and reports read `notes`, so it stays in the response
    // alongside the `description` column it is stored in.
    extraLegacy: { description: "notes" },
  },
  products: {
    columns: [
      "workspace_id",
      "name",
      "sku",
      "description",
      "price",
      "cost",
      "category",
      "active",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
    // `stock` and `minStock` have no column (the low-stock report in
    // routes/modules.js reads them off the record), so they ride in the
    // custom_fields bag and come back out under their original names.
  },
  quotes: {
    columns: [
      "workspace_id",
      "title",
      "quote_number",
      "deal_id",
      "company_id",
      "contact_id",
      "status",
      "subtotal",
      "discount",
      "tax",
      "total",
      "expiration_date",
      "items",
      "notes",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: {
      name: "title",
      subject: "title",
      quoteNumber: "quote_number",
      // The portal seeds quotes with a bare `number`; treating it as the quote
      // number keeps those records addressable.
      number: "quote_number",
      dealId: "deal_id",
      companyId: "company_id",
      contactId: "contact_id",
      expiresAt: "expiration_date",
      expirationDate: "expiration_date",
      lineItems: "items",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      quote_number: "quoteNumber",
      deal_id: "dealId",
      company_id: "companyId",
      contact_id: "contactId",
      expiration_date: "expirationDate",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
    extraLegacy: { title: "name" },
    titleFallbacks: [
      "name",
      "subject",
      "quoteNumber",
      "number",
      "customerEmail",
      "email",
    ],
  },
  contracts: {
    columns: [
      "workspace_id",
      "title",
      "contract_number",
      "deal_id",
      "company_id",
      "contact_id",
      "quote_id",
      "status",
      "value",
      "start_date",
      "end_date",
      "terms",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: {
      name: "title",
      subject: "title",
      contractNumber: "contract_number",
      number: "contract_number",
      dealId: "deal_id",
      companyId: "company_id",
      contactId: "contact_id",
      quoteId: "quote_id",
      startDate: "start_date",
      endDate: "end_date",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      contract_number: "contractNumber",
      deal_id: "dealId",
      company_id: "companyId",
      contact_id: "contactId",
      quote_id: "quoteId",
      start_date: "startDate",
      end_date: "endDate",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
    extraLegacy: { title: "name" },
    titleFallbacks: [
      "name",
      "subject",
      "contractNumber",
      "number",
      "customerEmail",
      "email",
    ],
  },
  orders: {
    columns: [
      "workspace_id",
      "order_number",
      "deal_id",
      "company_id",
      "contact_id",
      "quote_id",
      "contract_id",
      "status",
      "total",
      "items",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: {
      orderNumber: "order_number",
      number: "order_number",
      dealId: "deal_id",
      companyId: "company_id",
      contactId: "contact_id",
      quoteId: "quote_id",
      contractId: "contract_id",
      // modules.js aggregates `order.total`, but imported/legacy rows have been
      // seen using `amount`; both land in the same column.
      amount: "total",
      lineItems: "items",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      order_number: "orderNumber",
      deal_id: "dealId",
      company_id: "companyId",
      contact_id: "contactId",
      quote_id: "quoteId",
      contract_id: "contractId",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
  },
  invoices: {
    columns: [
      "workspace_id",
      "invoice_number",
      "order_id",
      "deal_id",
      "company_id",
      "contact_id",
      "status",
      "total",
      "due_date",
      "paid_at",
      "items",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: {
      invoiceNumber: "invoice_number",
      number: "invoice_number",
      orderId: "order_id",
      dealId: "deal_id",
      companyId: "company_id",
      contactId: "contact_id",
      dueDate: "due_date",
      paidAt: "paid_at",
      // The finance summary sums `invoice.amount`, so that is the canonical
      // legacy key; the column is `total` to match the other revenue money
      // columns.
      amount: "total",
      lineItems: "items",
      createdAt: "created_at",
      updated_at: "updated_at",
    },
    toLegacy: {
      invoice_number: "invoiceNumber",
      order_id: "orderId",
      deal_id: "dealId",
      company_id: "companyId",
      contact_id: "contactId",
      total: "amount",
      due_date: "dueDate",
      paid_at: "paidAt",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
  },
  expenses: {
    columns: [
      "workspace_id",
      "title",
      "category",
      "amount",
      "date",
      "vendor",
      "deal_id",
      "company_id",
      "user_id",
      "notes",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: {
      name: "title",
      dealId: "deal_id",
      companyId: "company_id",
      userId: "user_id",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      deal_id: "dealId",
      company_id: "companyId",
      user_id: "userId",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
    extraLegacy: { title: "name" },
    titleFallbacks: ["name", "vendor", "category"],
  },
  // ── Migration 007: marketing and service entities ────────────────────────
  //
  // The legacy label column is `name` for these tables, not `title`, so each
  // mapping below sets `titleColumn` to point the NOT NULL fallback at the
  // column the table actually has.
  campaigns: {
    columns: [
      "workspace_id",
      "name",
      "channel",
      "status",
      "description",
      "budget",
      "spend",
      "target",
      "reached",
      "leads",
      "start_date",
      "end_date",
      "metrics",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: {
      // App.tsx campaignFields keys the channel field `channel`, with the
      // values Email/SMS/Social/Multi-channel.
      type: "channel",
      startDate: "start_date",
      endDate: "end_date",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      channel: "channel",
      start_date: "startDate",
      end_date: "endDate",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
    titleColumn: "name",
    titleFallbacks: ["title", "channel", "description"],
  },
  email_lists: {
    columns: [
      "workspace_id",
      "name",
      "description",
      "status",
      "subscribers",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: {
      // A count, not an address list: helpers.js coerces with Number() and the
      // UI renders a number input.
      subscriberCount: "subscribers",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      subscribers: "subscribers",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
    titleColumn: "name",
    titleFallbacks: ["title", "description"],
  },
  forms: {
    columns: [
      "workspace_id",
      "name",
      "title",
      "description",
      "permalink",
      "submit_to",
      "progressive",
      "redirect_url",
      "enabled",
      "fields",
      "settings",
      "submission_count",
      "created_by",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: {
      submitTo: "submit_to",
      redirectUrl: "redirect_url",
      submissionCount: "submission_count",
      createdBy: "created_by",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      submit_to: "submitTo",
      redirect_url: "redirectUrl",
      submission_count: "submissionCount",
      created_by: "createdBy",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
    titleColumn: "name",
    titleFallbacks: ["title", "permalink"],
  },
  tickets: {
    columns: [
      "workspace_id",
      "subject",
      "description",
      "stage",
      "priority",
      "source",
      "contact",
      "contact_email",
      "comments",
      "first_response_at",
      "first_response_due_at",
      "resolved_at",
      "resolved_by",
      "sla_due_at",
      "sla_breached",
      "closed_at",
      "stage_history",
      "status",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: {
      // slaStatus() in routes/tickets.js branches on `stage`, so the column is
      // named `stage` even though the UI labels it a status.
      status: "stage",
      contactEmail: "contact_email",
      firstResponseAt: "first_response_at",
      firstResponseDueAt: "first_response_due_at",
      resolvedAt: "resolved_at",
      resolvedBy: "resolved_by",
      slaDueAt: "sla_due_at",
      slaBreached: "sla_breached",
      closedAt: "closed_at",
      stageHistory: "stage_history",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      stage: "stage",
      contact_email: "contactEmail",
      first_response_at: "firstResponseAt",
      first_response_due_at: "firstResponseDueAt",
      resolved_at: "resolvedAt",
      resolved_by: "resolvedBy",
      sla_due_at: "slaDueAt",
      sla_breached: "slaBreached",
      closed_at: "closedAt",
      stage_history: "stageHistory",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
    titleColumn: "subject",
    titleFallbacks: ["title", "name", "description"],
  },
  surveys: {
    columns: [
      "workspace_id",
      "name",
      "title",
      "description",
      "type",
      "question",
      "audience",
      "target_score",
      "status",
      "questions",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: {
      targetScore: "target_score",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      target_score: "targetScore",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
    titleColumn: "name",
    titleFallbacks: ["title", "question", "audience"],
  },
  survey_responses: {
    columns: [
      "workspace_id",
      "survey",
      "survey_id",
      "respondent",
      "respondent_email",
      "score",
      "comment",
      "responses",
      "submitted_at",
      "custom_fields",
      "created_at",
      "updated_at",
    ],
    toPg: {
      // `survey` holds a survey *name* in the legacy store, not an id.
      respondentEmail: "respondent_email",
      submittedAt: "submitted_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toLegacy: {
      respondent_email: "respondentEmail",
      submitted_at: "submittedAt",
      created_at: "createdAt",
      updated_at: "updatedAt",
    },
    hidden: ["workspace_id", "custom_fields"],
  },
};

/**
 * `toPg` and `toLegacy` are separate on purpose: a rename is not always its own
 * inverse. `dueDate` ↔ `due_date` is, but `name` → the `title` column is not -
 * deals answer with `title` *and* `name`, so the reverse direction has to be
 * spelled out rather than derived.
 */

/**
 * Mapping keys are snake_case, but callers hand us whatever spelling is in the
 * URL: the router receives `emailLists` and `surveyResponses` from the
 * frontend, while migrations and the backfill script use the table names
 * `email_lists` and `survey_responses`. A miss here is silent and damaging - it
 * falls back to the generic mapping, which drops `name` on the way in and
 * leaves `name`/`firstName` untranslated on the way out, so the caller gets a
 * NOT NULL violation or a snake_case payload instead of a clear miss. Resolve
 * the snake_case spelling before giving up.
 */
function mappingFor(resource) {
  if (typeof resource !== "string" || !resource) return null;
  const normalized = resource
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const direct = Object.prototype.hasOwnProperty.call(
    RESOURCE_MAPPINGS,
    resource,
  )
    ? RESOURCE_MAPPINGS[resource]
    : null;
  const mapping =
    direct ||
    (Object.prototype.hasOwnProperty.call(RESOURCE_MAPPINGS, normalized)
      ? RESOURCE_MAPPINGS[normalized]
      : null);
  return mapping
    ? { ...mapping, columnSet: mapping.columnSet || new Set(mapping.columns) }
    : null;
}

/** Convert a PG timestamp value to the ISO string the legacy contract expects. */
function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

// Columns the database types as a timestamp or date. A legacy caller may send an
// empty string to mean "no date set" - the JSON store accepted that, but
// PostgreSQL rejects '' for timestamptz with 22007, so blank those to NULL.
const TEMPORAL_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "due_date",
  "expected_close_date",
  "date",
  "expiration_date",
  "start_date",
  "end_date",
  "paid_at",
  // Added with migration 007. routes/tickets.js seeded firstResponseAt and
  // resolvedAt with empty strings, and a legacy client may send "" for
  // submitted_at too; without these the empty string reaches a timestamptz
  // column and the server rejects it with 22007 invalid datetime format.
  "first_response_at",
  "first_response_due_at",
  "resolved_at",
  "sla_due_at",
  "closed_at",
  "submitted_at",
]);

/** Coerce a legacy date value to something the timestamptz column accepts. */
function normalizeTemporalValue(value) {
  if (value === "" || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** Set an enumerable own property without invoking the legacy __proto__ setter. */
function setOwn(object, key, value) {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Convert a PG row (snake_case, Dates) → legacy API shape (camelCase strings).
 * `name` is reconstructed from first_name / last_name when available.
 *
 * `resource` is optional. The four core entities need the column knowledge in
 * RESOURCE_MAPPINGS; contacts and leads predate the mapping and rely on the
 * generic snake_case passthrough below.
 */
export function pgToLegacy(row, resource) {
  if (!row) return null;
  const mapping = mappingFor(resource);
  if (!mapping) return genericPgToLegacy(row);

  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (mapping.hidden.includes(key)) continue;
    const legacyKey = Object.prototype.hasOwnProperty.call(mapping.toLegacy, key)
      ? mapping.toLegacy[key]
      : key;
    if (value == null && (key === "created_at" || key === "updated_at")) {
      continue;
    }
    // PG hands back Date objects; the legacy contract is ISO strings. This
    // covers created_at/updated_at and every other timestamp column
    // (due_date, expected_close_date, ...) that res.json would otherwise have
    // to serialize for us.
    setOwn(out, legacyKey, value instanceof Date ? toIsoString(value) : value);
  }

  // Overflow bag last, so a real column always wins over a bag entry that
  // happens to share its name.
  const extra = row.custom_fields;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) setOwn(out, key, value);
    }
  }

  for (const [column, legacyKey] of Object.entries(mapping.extraLegacy || {})) {
    if (out[column] != null && out[legacyKey] === undefined) {
      out[legacyKey] = out[column];
    }
  }

  return out;
}

/**
 * Legacy behaviour for contacts and leads: strip the snake_case timestamps,
 * rebuild `name` from first_name / last_name, pass everything else through.
 */
function genericPgToLegacy(row) {
  const { custom_fields: bag, ...rest } = row;
  const out = {};
  // Overflow fields are re-exposed as top-level legacy keys, then the real
  // columns are layered on top so a column always wins a name collision.
  if (bag && typeof bag === "object" && !Array.isArray(bag)) {
    Object.assign(out, bag);
  }
  Object.assign(out, rest);
  if (out.created_at instanceof Date) {
    out.createdAt = out.created_at.toISOString();
  } else if (out.created_at) {
    out.createdAt = String(out.created_at);
  }
  if (out.updated_at instanceof Date) {
    out.updatedAt = out.updated_at.toISOString();
  } else if (out.updated_at) {
    out.updatedAt = String(out.updated_at);
  }
  delete out.created_at;
  delete out.updated_at;
  // Reconstruct `name` from first_name / last_name for backward compat
  if (out.first_name !== undefined || out.last_name !== undefined) {
    const parts = [out.first_name, out.last_name].filter(Boolean);
    out.name = parts.join(" ") || out.first_name || "";
  }
  return out;
}

/**
 * Convert an incoming legacy request body → PG repository input.
 * Splits `name` into first_name / last_name for contacts and leads; routes
 * known camelCase keys to their column and everything else into the
 * custom_fields bag for the four core entities.
 */
export function legacyToPg(body, resource) {
  const mapping = mappingFor(resource);
  if (!mapping) return genericLegacyToPg(body, resource);

  const out = {};
  const extra = {};
  for (const [key, value] of Object.entries(body || {})) {
    // The database owns the id and both timestamps: a client-supplied value
    // would either be rejected or pin updated_at forever.
    if (key === "id" || key === "createdAt" || key === "updatedAt") continue;
    if (key === "custom_fields") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(extra, value);
      }
      continue;
    }
    const column = mapping.toPg[key] || key;
    if (mapping.columnSet.has(column) && column !== "custom_fields") {
      if (column === "items") {
        // `lineItems` and `items` both land here; anything that is not already
        // an array is wrapped, because jsonb[] rejects a bare object.
        out[column] = Array.isArray(value)
          ? value
          : value == null || value === ""
            ? []
            : [value];
      } else {
        out[column] = TEMPORAL_COLUMNS.has(column)
          ? normalizeTemporalValue(value)
          : value;
      }
    } else {
      extra[key] = value;
    }
  }

  // `title` (quotes/contracts/expenses) and `name` (products) are NOT NULL, but
  // a legacy body keyed only on a number or a vendor would otherwise fail the
  // insert with 23502. Fall back through the candidate fields, in order, taking
  // the first one that carries a value.
  applyTitleFallback(mapping, out, body);

  // Left unset when empty so a partial PUT does not wipe the stored bag.
  if (Object.keys(extra).length) out.custom_fields = extra;
  return out;
}

/**
 * Fill a NOT NULL `title` column from a related field when the request did not
 * carry one. Every mapping that declares `titleFallbacks` has a `title` column;
 * products is the exception with `name NOT NULL` and deliberately has no
 * fallbacks, since a product with no name has nothing sensible to derive.
 */
function applyTitleFallback(mapping, out, body) {
  const fallbacks = mapping.titleFallbacks;
  if (!fallbacks) return;
  // The required label column differs per table: `title` for quotes,
  // contracts and expenses, `name` for campaigns, email_lists, forms and
  // surveys, `subject` for tickets. Defaulting to `title` keeps the existing
  // three mappings working unchanged.
  const column = mapping.titleColumn || "title";
  if (out[column] !== undefined && out[column] !== null && out[column] !== "")
    return;

  for (const key of fallbacks) {
    const value = body?.[key];
    const text = value == null ? "" : String(value).trim();
    if (text) {
      out[column] = text;
      return;
    }
  }
}

// Contacts and leads predate the mapping table above, but they still need the
// same column-vs-custom_fields split: any field without a home of its own goes
// into the JSONB overflow bag so a partial update can round-trip it instead of
// silently dropping it.
const GENERIC_COLUMNS = {
  contacts: new Set([
    "workspace_id",
    "company_id",
    "first_name",
    "last_name",
    "email",
    "phone",
    "title",
    "owner_id",
  ]),
  leads: new Set([
    "workspace_id",
    "first_name",
    "last_name",
    "email",
    "phone",
    "company_name",
    "status",
    "source",
    "value",
    "owner_id",
  ]),
};

// The schema reflection API (services/schema.js) publishes the natural public
// keys `firstName` / `lastName`, while the columns are `first_name` /
// `last_name`. Accepting the camelCase spelling here keeps a form generated
// purely from the reflection response round-tripping into the real columns
// instead of landing in the custom_fields overflow bag.
const GENERIC_ALIASES = {
  contacts: { firstName: "first_name", lastName: "last_name" },
  leads: { firstName: "first_name", lastName: "last_name" },
};

function genericLegacyToPg(body, resource) {
  const data = { ...(body || {}) };
  const columns = GENERIC_COLUMNS[resource];
  const aliases = GENERIC_ALIASES[resource] || {};
  const out = {};
  const extra = {};

  if ("name" in data) {
    const parts = String(data.name || "")
      .trim()
      .split(/\s+/);
    out.first_name = parts[0] || "";
    out.last_name = parts.slice(1).join(" ") || undefined;
    delete data.name;
  }

  for (const [key, value] of Object.entries(data)) {
    // The database owns the id and both timestamps.
    if (key === "id" || key === "createdAt" || key === "updatedAt") continue;
    if (key === "custom_fields") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(extra, value);
      }
      continue;
    }
    const column = aliases[key] || key;
    if (!columns || columns.has(column)) {
      out[column] = value;
    } else {
      extra[key] = value;
    }
  }

  if (Object.keys(extra).length) out.custom_fields = extra;
  return out;
}
