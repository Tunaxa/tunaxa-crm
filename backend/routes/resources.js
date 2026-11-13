import path from "node:path";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readDb, mutateDb } from "../store.js";
import { auth } from "../middleware/auth.js";
import { updateRecord } from "../services/resources.js";
import { updatedEvent, eventFor } from "../services/workflows.js";
import { recordRevision } from "../services/revisions.js";
import { requireRole } from "../middleware/rbac.js";
import {
  BUILT_IN_FIELDS,
  OBJECT_MAP,
  id,
  now,
  auditEntry,
  coerceBuiltIns,
  coerceCustomFields,
  partialDelta,
  applyPartialUpdate,
  resources,
  paginateAndSort,
  SERVER_OWNED_FIELDS,
} from "../helpers.js";
import { validate, ResourceSchema, BatchSchema } from "../services/validate.js";
import { triggerWorkflows, createdEvent } from "../services/workflows.js";
import { broadcast } from "./sse.js";
import { cacheFlush } from "../services/cache.js";
import {
  getFieldPermissions,
  applyFieldMasking,
  checkWriteFieldMask,
  objectTypeOf,
} from "./permissions.js";
import { parseFilters, applyFilters } from "../services/queryFilter.js";
import { fileURLToPath } from "node:url";
import { repoFor } from "../db/repositories/index.js";
import { PG_RESOURCES, pgToLegacy, legacyToPg } from "../db/legacy-shape.js";

// Query params that are filters rather than paging controls. The legacy JSON
// path applied these in JS after loading the whole file; forwarding them to the
// repository keeps the same results while pushing the work into SQL. Repos
// ignore the keys they do not implement.
//
// `category` has to be listed here or it never reaches SQL: products and
// expenses both implement a category filter, and because findAll() destructures
// its argument, an unlisted key is dropped silently rather than rejected.
//
// The 007 entities add filters on their own vocabulary: campaigns by channel,
// forms by enabled/submitTo, tickets by priority/source, surveys by audience,
// and survey responses by survey name and respondent email. `stage` and
// `status` are already covered by the revenue cutover.
const PG_FILTER_KEYS = [
  "q",
  "type",
  "contact",
  "recordId",
  "stage",
  "status",
  "category",
  "channel",
  "enabled",
  "submitTo",
  "priority",
  "source",
  "audience",
  "survey",
  "respondentEmail",
];

// Hard stop on page-through loops. A repository that reports a total it cannot
// deliver would otherwise spin until the request times out.
const MAX_PG_PAGES = 50;

function readPgFilters(query) {
  const filters = {};
  for (const key of PG_FILTER_KEYS) {
    if (query[key] !== undefined && query[key] !== "")
      filters[key] = query[key];
  }
  // `completed` has to arrive as a real boolean: a non-empty string is truthy
  // in SQL, so the string "false" would filter for completed work.
  if (query.completed !== undefined && query.completed !== "") {
    filters.completed = query.completed === "true";
  }
  return filters;
}

/**
 * Fetch every row of a PG resource as a flat legacy array.
 *
 * The legacy contract is a bare JSON array, so this pages the whole result set
 * rather than returning a single page. A caller that asks for a specific
 * `page`/`limit` gets exactly that, which is what makes `export.csv` and the
 * duplicate detector see the complete set.
 */
async function pgFindAll(resource, query = {}, workspaceId = undefined) {
  const repo = repoFor(resource);
  const filters = readPgFilters(query);
  if (query.sortBy) filters.sortBy = query.sortBy;
  // Tenant scoping is applied in SQL, not by filtering the returned rows: a
  // post-filter would report a `total` that does not match the page and would
  // silently return short pages.
  if (workspaceId !== undefined && workspaceId !== null) {
    filters.workspaceId = workspaceId;
  }

  const hasPaging = query.page !== undefined || query.limit !== undefined;
  if (hasPaging) {
    filters.page = Number(query.page) || 1;
    filters.limit = Number(query.limit) || 20;
    const result = await repo.findAll(filters);
    return result.data.map((row) =>
      coerceBuiltIns(resource, pgToLegacy(row, resource)),
    );
  }

  const rows = [];
  for (let page = 1; page <= MAX_PG_PAGES; page++) {
    const result = await repo.findAll({ ...filters, page, limit: 100 });
    rows.push(
      ...result.data.map((row) =>
        coerceBuiltIns(resource, pgToLegacy(row, resource)),
      ),
    );
    if (result.data.length === 0 || rows.length >= result.total) break;
  }
  return rows;
}

// The public list contract is camelCase with a separate ?sortDir=, while the PG
// repositories sort with a whitelisted `column:direction` string. Translate
// here so `?sortBy=createdAt&sortDir=asc` works identically on both storage
// paths instead of silently falling back to `created_at DESC`.
const PG_SORT_ALIASES = {
  createdAt: "created_at",
  updatedAt: "updated_at",
};

function pgSortBy(query = {}) {
  const sortBy = String(query.sortBy || "createdAt");
  const sortDir =
    String(query.sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  const column = PG_SORT_ALIASES[sortBy] || sortBy;
  return `${column}:${sortDir}`;
}

/**
 * Fetch one page of a PG resource in the canonical list envelope.
 *
 * `total` comes from the repository's COUNT, so it is the size of the filtered
 * set rather than the size of the page. Tenant scoping and filters stay in SQL
 * via `readPgFilters` + `workspaceId`.
 */
async function pgList(resource, query = {}, workspaceId = undefined) {
  const repo = repoFor(resource);
  if (!repo || typeof repo.findAll !== "function") {
    const error = new Error(`No repository registered for ${resource}`);
    error.status = 500;
    throw error;
  }

  const filters = readPgFilters(query);
  filters.sortBy = pgSortBy(query);
  if (workspaceId !== undefined && workspaceId !== null) {
    filters.workspaceId = workspaceId;
  }

  const page = Math.max(1, parseInt(String(query.page), 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(String(query.limit), 10) || 25),
  );

  const result = await repo.findAll({ ...filters, page, limit });
  return {
    data: result.data.map((row) =>
      coerceBuiltIns(resource, pgToLegacy(row, resource)),
    ),
    total: result.total,
    page,
    limit,
  };
}

const root = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(root, "..", "uploads");

// Fields the client may never set when updating a record: the stored values
// always win. Stripped from the payload rather than re-pinned after the merge,
// so there is a single mechanism to reason about.

/**
 * The tenant a request acts within.
 *
 * Mirrors the idiom already used by routes/goals.js so that a user record
 * without an explicit workspace still resolves to the `default` tenant, which
 * is also the column default in the migrations. Getting this wrong in either
 * direction is a security bug: a wrong value leaks another tenant's rows, and
 * an undefined value silently disables the scoping entirely.
 */
function tenantOf(req) {
  return req.user?.workspaceId || req.user?.workspace_id || "default";
}

// Fields considered when searching a resource via GET /api/:resource?q=.
// Only meaningful, user-facing text fields are matched instead of the whole
// serialized record, which keeps the search fast and avoids exposing hidden
// or derived data embedded in records.
const SEARCH_FIELDS = {
  leads: ["name", "email", "company", "phone"],
  contacts: ["name", "email", "company", "phone"],
  companies: ["name", "industry", "website", "country"],
  deals: ["title", "company", "stage"],
  tasks: ["title", "owner", "status"],
  activities: ["title", "contact", "company", "type"],
  calls: ["title", "contact", "company"],
  recordings: ["title", "contact", "transcript"],
  messages: ["subject", "body", "from", "to"],
  templates: ["name", "subject", "body"],
  sequences: ["name", "description"],
  workflows: ["name", "trigger", "description"],
  team: ["name", "email", "role", "status"],
  products: ["name", "sku", "description"],
  invoices: ["number", "company", "status"],
  expenses: ["title", "category"],
  quotes: ["title", "company", "status"],
  contracts: ["title", "company", "status"],
  goals: ["title", "owner"],
  surveys: ["title"],
  webhookEndpoints: ["name", "url"],
  audit: ["action", "actor"],
};

const DEFAULT_SEARCH_FIELDS = [
  "name",
  "email",
  "title",
  "subject",
  "company",
  "phone",
  "contact",
];

// Build the CSV header column order without scanning the whole dataset:
// prefer the first record's keys (already field-masked), and fall back to the
// built-in + custom field definitions so an empty dataset still gets a header.
function csvColumns(db, resource, firstRow) {
  if (firstRow && Object.keys(firstRow).length > 0) {
    return Object.keys(firstRow);
  }

  const builtIn = (BUILT_IN_FIELDS[resource] || []).map((field) => field.key);
  const object = OBJECT_MAP[resource];
  const custom = object
    ? (db.customFields || [])
        .filter(
          (field) =>
            String(field.object || "").toLowerCase() === object.toLowerCase(),
        )
        .map((field) => field.key)
    : [];

  return [...new Set([...builtIn, ...custom])];
}

export default function registerResourceRoutes(app) {
  // Attach field-level permissions for the authenticated user. Must run AFTER
  // `auth` so req.user is populated — otherwise masking is a silent no-op.
  // It also loads req.db here (post-auth), matching HEAD's lazy-read timing so
  // the store's serialized queue ordering for workflow triggers is preserved.
  async function attachFieldPerms(req, res, next) {
    if (!req.user || !resources.has(req.params.resource)) return next();
    const db = req.db || (await readDb());
    req.db = db;
    req.fieldPerms = getFieldPermissions(
      req.db,
      objectTypeOf(req.params.resource),
      req.user.role,
    );
    next();
  }

  /**
   * GET /api/:resource
   * Protected. Lists records of a registered resource.
   * PostgreSQL-backed resources are read through their repository (tenant-scoped
   * in SQL, field-masked after auth); JSON-store resources are filtered in memory.
   * Query params: page, limit (1-100), q, filters (JSON), plus
   * resource-specific filters such as type/recordId/contact (activities) and
   * type (messages).
   * Response: 200 { data, total, page, limit }. Advanced filters are supported
   * for JSON-store resources; PG-backed resources reject them with 400 until the
   * predicate can be pushed into SQL.
   */
  app.get("/api/:resource", auth, attachFieldPerms, async (req, res, next) => {
    if (!resources.has(req.params.resource)) return next();

    // Advanced filter payload: validated up front so a malformed schema is a
    // 400 before any storage work.
    let advancedFilters = null;

    if (req.query.filters !== undefined) {
      try {
        advancedFilters = parseFilters(req.query.filters);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }

    // ── PG path: every resource in PG_RESOURCES ───────────────────────────
    if (PG_RESOURCES.has(req.params.resource)) {
      // The filter engine runs in memory over legacy-shaped rows, so it cannot
      // push a predicate into the repository's SQL. Fetching the whole table
      // just to filter one page would be an unbounded read, so reject the
      // combination explicitly instead of silently ignoring it.
      if (advancedFilters) {
        return res.status(400).json({
          error:
            "Advanced query filters are not yet supported for postgres-backed resources",
        });
      }
      try {
        const payload = await pgList(
          req.params.resource,
          req.query,
          tenantOf(req),
        );
        // pgList() returns the canonical list envelope, so mask the page before
        // it leaves the route; otherwise post-auth field permissions are a
        // silent no-op on PG-backed collections.
        if (req.fieldPerms) {
          payload.data = payload.data.map((item) =>
            applyFieldMasking(item, req.fieldPerms),
          );
        }
        return res.json(payload);
      } catch (err) {
        return next(err);
      }
    }

    // ── Legacy JSON path: all other resources ──────────────────────────────
    const db = req.db || (await readDb());

    let rows = db[req.params.resource] || [];

    const q = String(req.query.q || "")
      .toLowerCase()
      .trim();

    if (q) {
      const fields = SEARCH_FIELDS[req.params.resource] || DEFAULT_SEARCH_FIELDS;

      rows = rows.filter((item) =>
        fields.some((field) =>
          String(item[field] ?? "").toLowerCase().includes(q),
        ),
      );
    }

    if (req.params.resource === "activities") {
      const type = String(req.query.type || "").toLowerCase();

      if (type) {
        const directTypes = ["email", "call", "meeting", "note"];

        rows = rows.filter((item) => {
          const itemType = String(item.type || "").toLowerCase();

          return type === "system"
            ? !directTypes.includes(itemType)
            : itemType === type;
        });
      }

      const recordId = String(req.query.recordId || "");
      const contact = String(req.query.contact || "")
        .trim()
        .toLowerCase();

      if (recordId || contact) {
        rows = rows.filter(
          (item) =>
            (recordId && item.recordId === recordId) ||
            (contact &&
              (String(item.contact || "").toLowerCase() === contact ||
                String(item.company || "").toLowerCase() === contact ||
                String(item.title || "")
                  .toLowerCase()
                  .includes(contact))),
        );
      }
    }

    // AXA-128: only return email messages when type=email is requested
    if (req.params.resource === "messages") {
      const type = String(req.query.type || "").toLowerCase();

      if (type === "email") {
        rows = rows.filter(
          (item) => String(item.channel || "").toLowerCase() === "email",
        );
      }
    }

    // Compounds with q / type / recordId above, and feeds the pagination
    // below so `total` reflects the filtered set.
    rows = applyFilters(rows, advancedFilters);

    if (req.fieldPerms) {
      rows = rows.map((item) => applyFieldMasking(item, req.fieldPerms));
    }

    res.json(paginateAndSort(rows, req.query));
  });

  /**
   * GET /api/:resource/export.csv
   * Protected. Streams all records of a resource as a CSV attachment, applying
   * field-masking permissions per row as it streams. PostgreSQL-backed
   * resources are tenant-scoped in SQL.
   * Response: 200 text/csv attachment
   */
  app.get("/api/:resource/export.csv", auth, attachFieldPerms, async (req, res, next) => {
    if (!resources.has(req.params.resource)) return next();

    const db = req.db || (await readDb());

    let rows;
    if (PG_RESOURCES.has(req.params.resource)) {
      try {
        // Already legacy-shaped by the time it gets here, so the header keeps
        // the same camelCase names the JSON-backed exports have always used.
        // Tenant scoping is applied inside pgFindAll(), in SQL.
        rows = await pgFindAll(req.params.resource, {}, tenantOf(req));
        if (req.fieldPerms) {
          rows = rows.map((item) => applyFieldMasking(item, req.fieldPerms));
        }
      } catch (err) {
        return next(err);
      }
    } else {
      rows = db[req.params.resource] || [];
    }

    // Field masking is applied lazily, once per row, as it is written.
    const mask = req.fieldPerms
      ? (item) => applyFieldMasking(item, req.fieldPerms)
      : (item) => item;

    const cell = (value) => {
      const text =
        value == null
          ? ""
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);

      return `"${text.replace(/"/g, '""')}"`;
    };

    // Extract the header from the first record only (already field-masked),
    // falling back to the schema definitions when the dataset is empty.
    const firstRow = rows.length > 0 ? mask(rows[0]) : undefined;
    const columns = csvColumns(db, req.params.resource, firstRow);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${req.params.resource}.csv"`,
    );

    // Stream rows one at a time instead of materializing the whole CSV:
    // each chunk is field-masked on the fly as it passes through the pipeline.
    function* csvLines() {
      yield `${columns.map((column) => cell(column)).join(",")}\r\n`;

      for (const item of rows) {
        const row = mask(item);
        yield `${columns.map((column) => cell(row[column])).join(",")}\r\n`;
      }
    }

    try {
      await pipeline(Readable.from(csvLines()), res);
    } catch (error) {
      // A client that disconnects mid-download is normal, not a server fault.
      if (error?.code !== "EPIPE" && error?.code !== "ECONNRESET") {
        throw error;
      }
    }
  });

  // Bulk batch operations. Registered before every `/:id` route so the literal
  // segment "batch" is never captured as a record id.
  //
  // Both handlers mirror the single-record contracts: the tenant is always
  // server-derived, server-owned fields are stripped from the payload, write
  // field masks are enforced, and PostgreSQL-backed resources go through their
  // repository instead of the legacy JSON array. A record that exists only in
  // another tenant is reported exactly like a missing one.
  const FORBIDDEN_UPDATE_KEYS = new Set([
    "__proto__",
    "constructor",
    "prototype",
  ]);

  function tenantMatches(record, tenantId) {
    const recordTenant = record?.workspaceId ?? record?.workspace_id;

    // Rows written before workspaces existed carry no tenant and belong to the
    // default workspace, matching the SQL predicate in update-builder.js.
    if (recordTenant === undefined || recordTenant === null) {
      return tenantId === "default";
    }

    return recordTenant === tenantId;
  }

  function batchIds(req, res) {
    const { ids } = req.body || {};

    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) {
      res.status(400).json({
        error: "ids must be an array containing between 1 and 100 items",
      });
      return null;
    }

    if (
      ids.some(
        (value) => typeof value !== "string" || value.trim().length === 0,
      )
    ) {
      res.status(400).json({ error: "ids must contain non-empty strings" });
      return null;
    }

    // Duplicate ids would apply the mutation twice, or report a false failure
    // on the second delete, for one logical operation.
    return [...new Set(ids.map((value) => value.trim()))];
  }

  function batchUpdateData(req, res) {
    const { data } = req.body || {};

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      res.status(400).json({ error: "data must be an object" });
      return null;
    }

    // Object.fromEntries never invokes a prototype setter, and the explicit
    // denylist keeps the delta free of keys that could reach Object.prototype.
    // SERVER_OWNED_FIELDS stops a caller from moving a record to another
    // workspace or pinning its timestamps.
    return Object.fromEntries(
      Object.entries(data).filter(
        ([key]) =>
          !FORBIDDEN_UPDATE_KEYS.has(key) && !SERVER_OWNED_FIELDS.has(key),
      ),
    );
  }

  function broadcastBatch(event, payload, req) {
    const workspaceId = req.user?.workspaceId;

    // Never fall back to a shared "default" room: sockets without a workspace
    // join a user-scoped room, so a "default" broadcast would either be lost or
    // leak across tenants.
    if (!workspaceId) return;

    broadcast(event, payload, { workspaceId });
  }

  /**
   * PATCH /api/:resource/batch
   * Admin/member. Applies one partial delta to up to 100 tenant-scoped records.
   * "batch" is a literal segment, not a record id, so this route is registered
   * above the parameterized routes.
   * Body: { ids: string[], data: object }
   * Response: 200 when every record updated, 207 when some were rejected, 400
   * when every id failed. { successCount, errorCount, errors: [{ id, reason }] }
   */
  app.patch(
    "/api/:resource/batch",
    auth,
    attachFieldPerms,
    requireRole("admin", "member"),
    // The delta lives under `data`, not at the top level, so the mask has to be
    // pointed at it explicitly. Checking `req.body` would only ever see the
    // `ids`/`data` keys.
    checkWriteFieldMask(undefined, (req) => req.body?.data),
    async (req, res, next) => {
      const resource = req.params.resource;

      if (
        resource === "__proto__" ||
        resource === "constructor" ||
        resource === "prototype"
      ) {
        return next();
      }
      if (!resources.has(resource)) return next();

      const ids = batchIds(req, res);
      if (!ids) return;

      const update = batchUpdateData(req, res);
      if (!update) return;

      const tenantId = tenantOf(req);
      const errors = [];
      const updated = [];

      if (PG_RESOURCES.has(resource)) {
        const repo = repoFor(resource);
        const pgDelta = coerceBuiltIns(
          resource,
          legacyToPg({ ...update }, resource, { partial: true }),
        );

        for (const idVal of ids) {
          try {
            const stored = await repo.findById(idVal, tenantId);
            if (!stored) {
              errors.push({ id: idVal, reason: "Record not found" });
              continue;
            }

            const previous = pgToLegacy(stored, resource);
            const row =
              Object.keys(pgDelta).length > 0
                ? await repo.update(idVal, pgDelta, tenantId)
                : stored;
            if (!row) {
              errors.push({ id: idVal, reason: "Record not found" });
              continue;
            }

            updated.push({
              id: idVal,
              previous,
              item: coerceBuiltIns(resource, pgToLegacy(row, resource)),
            });
          } catch {
            // One bad row must not abort the batch, and the reason stays
            // generic so a database error is not reflected to the caller.
            errors.push({ id: idVal, reason: "Update failed" });
          }
        }

        if (updated.length) {
          await mutateDb((db) => {
            for (const entry of updated) {
              entry.revisionId = recordRevision(
                db,
                resource,
                entry.previous,
                entry.item,
                req.user,
              );
              db.audit.unshift(
                auditEntry({
                  action:
                    `Updated ${resource.slice(0, -1)}` +
                    (ids.length > 1 ? " (batch)" : ""),
                  actor: req.user.name,
                  req,
                  resourceId: entry.id,
                }),
              );
            }
          });
        }
      } else {
        await mutateDb((db) => {
          const rows = db[resource] || [];

          for (const idVal of ids) {
            const index = rows.findIndex(
              (item) => item.id === idVal && tenantMatches(item, tenantId),
            );
            if (index < 0) {
              errors.push({ id: idVal, reason: "Record not found" });
              continue;
            }

            const previous = { ...rows[index] };
            const merged = applyPartialUpdate(
              rows[index],
              coerceBuiltIns(
                resource,
                coerceCustomFields(db, resource, { ...update }),
              ),
            );
            // Re-asserted rather than spread: the delta cannot carry them, but
            // a stored record missing one keeps the value it had.
            merged.id = rows[index].id;
            if (rows[index].createdAt !== undefined) {
              merged.createdAt = rows[index].createdAt;
            }
            merged.updatedAt = now();
            rows[index] = merged;

            updated.push({
              id: idVal,
              previous,
              item: merged,
              revisionId: recordRevision(
                db,
                resource,
                previous,
                merged,
                req.user,
              ),
            });
            db.audit.unshift(
              auditEntry({
                action:
                  `Updated ${resource.slice(0, -1)}` +
                  (ids.length > 1 ? " (batch)" : ""),
                actor: req.user.name,
                req,
                resourceId: idVal,
              }),
            );
          }
        });
      }

      if (updated.length) {
        cacheFlush(resource);
        for (const entry of updated) {
          broadcastBatch(
            "record.updated",
            { resource, item: entry.item, revisionId: entry.revisionId },
            req,
          );
        }
        broadcastBatch(
          "records.batch",
          { resource, count: updated.length, operation: "patch" },
          req,
        );
      }

      const status =
        errors.length === 0
          ? 200
          : errors.length === ids.length
            ? 400
            : 207;
      res.status(status).json({
        successCount: updated.length,
        errorCount: errors.length,
        errors,
      });
    },
  );

  /**
   * DELETE /api/:resource/batch
   * Admin/member. Deletes up to 100 tenant-scoped records. PostgreSQL-backed
   * resources go through their repository; JSON-backed resources also drop the
   * same derived rows and uploaded files as the single-record route.
   * Body: { ids: string[] }
   * Response: 200 / 207 / 400 with { successCount, errorCount, errors }.
   */
  app.delete(
    "/api/:resource/batch",
    auth,
    attachFieldPerms,
    requireRole("admin", "member"),
    async (req, res, next) => {
      const resource = req.params.resource;

      if (
        resource === "__proto__" ||
        resource === "constructor" ||
        resource === "prototype"
      ) {
        return next();
      }
      if (!resources.has(resource)) return next();

      const ids = batchIds(req, res);
      if (!ids) return;

      const tenantId = tenantOf(req);
      const errors = [];
      const deletedIds = [];
      let files = [];

      if (PG_RESOURCES.has(resource)) {
        const repo = repoFor(resource);

        for (const idVal of ids) {
          try {
            const deleted = await repo.delete(idVal, tenantId);
            if (!deleted) {
              errors.push({ id: idVal, reason: "Record not found" });
              continue;
            }

            deletedIds.push(idVal);
          } catch {
            errors.push({ id: idVal, reason: "Delete failed" });
          }
        }

        if (deletedIds.length) {
          await mutateDb((db) => {
            for (const idVal of deletedIds) {
              db.audit.unshift(
                auditEntry({
                  action:
                    `Deleted ${resource.slice(0, -1)}` +
                    (ids.length > 1 ? " (batch)" : ""),
                  actor: req.user.name,
                  req,
                  resourceId: idVal,
                }),
              );
            }
          });
        }
      } else {
        files = await mutateDb((db) => {
          const rows = db[resource] || [];
          const removedFiles = [];

          for (const idVal of ids) {
            const index = rows.findIndex(
              (item) => item.id === idVal && tenantMatches(item, tenantId),
            );
            if (index < 0) {
              errors.push({ id: idVal, reason: "Record not found" });
              continue;
            }

            const [removed] = rows.splice(index, 1);
            deletedIds.push(idVal);

            if (resource === "calls") {
              db.activities = db.activities.filter(
                (item) => item.callId !== removed.id,
              );

              const linked = db.recordings.filter(
                (item) => item.callId === removed.id,
              );

              removedFiles.push(
                ...linked.map((item) => item.fileUrl).filter(Boolean),
              );

              db.recordings = db.recordings.filter(
                (item) => item.callId !== removed.id,
              );
            }

            if (resource === "recordings") {
              if (removed.fileUrl) {
                removedFiles.push(removed.fileUrl);
              }

              if (removed.callId) {
                const call = db.calls.find(
                  (item) => item.callId === removed.id,
                );

                if (call?.recordingId === removed.id) {
                  delete call.recordingId;
                }
              }
            }

            if (resource === "messages") {
              db.activities = db.activities.filter(
                (item) => item.messageId !== removed.id,
              );
            }

            db.audit.unshift(
              auditEntry({
                action:
                  `Deleted ${resource.slice(0, -1)}` +
                  (ids.length > 1 ? " (batch)" : ""),
                actor: req.user.name,
                req,
                resourceId: removed.id,
              }),
            );
          }

          return removedFiles;
        });

        await Promise.all(
          files.map(async (fileUrl) => {
            const name = path.basename(String(fileUrl));

            if (!name) return;

            try {
              await fs.unlink(path.join(uploadDir, name));
            } catch (error) {
              if (process.env.NODE_ENV !== "production") {
                console.warn("Failed to remove uploaded file", error.message);
              }
            }
          }),
        );
      }

      if (deletedIds.length) {
        cacheFlush(resource);
        for (const idVal of deletedIds) {
          broadcastBatch("record.deleted", { resource, id: idVal }, req);
        }
        broadcastBatch(
          "records.batch",
          { resource, count: deletedIds.length, operation: "delete" },
          req,
        );
      }

      const status =
        errors.length === 0
          ? 200
          : errors.length === ids.length
            ? 400
            : 207;
      res.status(status).json({
        successCount: deletedIds.length,
        errorCount: errors.length,
        errors,
      });
    },
  );

  /**
   * GET /api/:resource/:id
   * Protected. Returns a single record by id (PostgreSQL-backed resources are
   * tenant-scoped in SQL) and applies field masking.
   * Path param: :id - record id
   * Response: 200 { record } | 404 { error }
   */
  app.get("/api/:resource/:id", auth, attachFieldPerms, async (req, res, next) => {
    if (!resources.has(req.params.resource)) return next();

    // ── PG path ───────────────────────────────────────────────────────────
    if (PG_RESOURCES.has(req.params.resource)) {
      const repo = repoFor(req.params.resource);
      try {
        const row = await repo.findById(req.params.id, tenantOf(req));
        if (!row) return res.status(404).json({ error: "Record not found" });
        const item = coerceBuiltIns(
          req.params.resource,
          pgToLegacy(row, req.params.resource),
        );
        return res.json(
          req.fieldPerms ? applyFieldMasking(item, req.fieldPerms) : item,
        );
      } catch (err) {
        return next(err);
      }
    }

    // ── Legacy JSON path ──────────────────────────────────────────────────
    const db = req.db || (await readDb());
    const rows = db[req.params.resource] || [];
    const item = rows.find((x) => x.id === req.params.id);

    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    res.json(req.fieldPerms ? applyFieldMasking(item, req.fieldPerms) : item);
  });

  /**
   * POST /api/:resource
   * Admin/member. Creates a single record (coerces built-in + custom fields),
   * records an audit entry, and fires workflow triggers/SSE events. Masked
   * fields are rejected by checkWriteFieldMask.
   * Body (ResourceSchema): record fields
   * Response: 201 { record }
   */
  app.post(
    "/api/:resource",
    auth,
    requireRole("admin", "member"),
    checkWriteFieldMask(),
    validate(ResourceSchema),
    async (req, res, next) => {
      const resource = req.params.resource;

      if (!resources.has(resource)) return next();

      // ── PG path ──────────────────────────────────────────────────────────
      if (PG_RESOURCES.has(resource)) {
        const repo = repoFor(resource);
        try {
          const pgData = legacyToPg({ ...req.body }, resource);
          // The workspace is server-derived. Honouring a client-supplied
          // workspace_id would let any authenticated user create records inside
          // another tenant.
          pgData.workspace_id = tenantOf(req);
          // Coerce numeric built-ins (e.g. deals.value, companies.employees)
          coerceBuiltIns(resource, pgData);
          const row = await repo.create(pgData);
          const item = pgToLegacy(row, resource);
          await mutateDb(db => {
            db.audit.unshift(auditEntry({ action: `Created ${resource.slice(0, -1)}`, actor: req.user.name, req, resourceId: item.id }));
          });
          const event = createdEvent(resource);
          if (event) triggerWorkflows(resource, event, item);
          broadcast("record.created", { resource, item });
          cacheFlush(resource);
          return res.status(201).json(item);
        } catch (err) {
          return next(err);
        }
      }

      // ── Legacy JSON path ──────────────────────────────────────────────────
      const item = await mutateDb((db) => {
        const createdAt = now();
        const data = { ...req.body };

        const record = {
          id: id(resource.slice(0, -1) || "item"),
          ...coerceBuiltIns(resource, coerceCustomFields(db, resource, data)),
          createdAt,
          updatedAt: createdAt,
        };

        db[resource].unshift(record);

        if (resource === "messages") {
          db.activities.unshift({
            id: id("activity"),
            title: `${record.channel || "Message"} to ${
              record.to || "recipient"
            }`,
            type: record.channel || "Email",
            contact: record.to || "",
            notes: record.subject || record.body || "",
            date: createdAt.slice(0, 10),
            messageId: record.id,
            createdAt,
            updatedAt: createdAt,
          });
        }

        if (resource !== "audit") {
          db.audit.unshift(
            auditEntry({
              action: `Created ${resource.slice(0, -1)}`,
              actor: req.user.name,
              createdAt,
              req,
              resourceId: record.id,
            }),
          );
        }

        return record;
      });

      const event = createdEvent(resource);
      if (event) triggerWorkflows(resource, event, item);
      broadcast(
        "record.created",
        { resource, item },
        req.user.workspaceId || "default",
      );
      cacheFlush(resource);

      res.status(201).json(item);
    },
  );

  /**
   * POST /api/:resource/batch
   * Admin/member. Bulk-imports an array of records for a resource with one
   * combined audit entry; every element is checked against write field masks.
   * Body (BatchSchema): [{ record fields }]
   * Response: 201 [{ record }]
   */
  app.post(
    "/api/:resource/batch",
    auth,
    requireRole("admin", "member"),
    // Per-element, not per-request: a batch is the obvious way to smuggle one
    // masked field past a check that only inspects the first object.
    checkWriteFieldMask(),
    validate(BatchSchema),
    async (req, res, next) => {
      const resource = req.params.resource;

      if (!resources.has(resource)) return next();

      // ── PG path ──────────────────────────────────────────────────────────
      if (PG_RESOURCES.has(resource)) {
        const repo = repoFor(resource);
        try {
          const saved = await Promise.all(
            req.body.map(async (data) => {
              const pgData = legacyToPg({ ...data }, resource);
              // Server-derived, same as the single-create path: a batch must not
              // be a way around tenant assignment.
              pgData.workspace_id = tenantOf(req);
              coerceBuiltIns(resource, pgData);
              const row = await repo.create(pgData);
              return pgToLegacy(row, resource);
            }),
          );
          broadcast("records.batch", { resource, count: saved.length });
          cacheFlush(resource);
          return res.status(201).json(saved);
        } catch (err) {
          return next(err);
        }
      }

      // ── Legacy JSON path ──────────────────────────────────────────────────
      const incoming = req.body;

      const saved = await mutateDb((db) => {
        const rows = incoming.map((data) => ({
          id: id(resource.slice(0, -1) || "item"),
          ...coerceBuiltIns(
            resource,
            coerceCustomFields(db, resource, { ...data }),
          ),
          createdAt: now(),
          updatedAt: now(),
        }));

        db[resource].unshift(...rows);

        db.audit.unshift(
          auditEntry({
            action: `Imported ${rows.length} ${resource}`,
            actor: req.user.name,
            req,
            resourceId: rows.map((row) => row.id).join(","),
          }),
        );

        return rows;
      });
      broadcast(
        "records.batch",
        { resource, count: saved.length },
        req.user.workspaceId || "default",
      );
      cacheFlush(resource);

      res.status(201).json(saved);
    },
  );

  /**
   * PUT /api/:resource/:id
   * Admin/member. Replaces fields on an existing record, records a revision and
   * audit entry, and fires workflow triggers/SSE events. PostgreSQL-backed
   * records are tenant-scoped in SQL.
   * Path param: :id - record id
   * Body (ResourceSchema): record fields to update
   * Response: 200 { record, revisionId? } | 404 { error }
   */
  app.put(
    "/api/:resource/:id",
    auth,
    requireRole("admin", "member"),
    checkWriteFieldMask(),
    validate(ResourceSchema),
    async (req, res, next) => {
      const resource = req.params.resource;
      if (!resources.has(resource)) return next();

      // ── PG path ──────────────────────────────────────────────────────────
      if (PG_RESOURCES.has(resource)) {
        const repo = repoFor(resource);
        try {
          const pgData = legacyToPg({ ...req.body }, resource);
          coerceBuiltIns(resource, pgData);
          const workspaceId = tenantOf(req);
          const previousRow = await repo.findById(req.params.id, workspaceId);
          if (!previousRow)
            return res.status(404).json({ error: "Record not found" });
          const previous = pgToLegacy(previousRow, resource);
          // An empty payload (only the id/timestamps were sent) must still
          // return the record rather than 404: PUT keeps PATCH's merge
          // semantics, and repo.update() bails on an empty field set.
          const row =
            Object.keys(pgData).length > 0
              ? await repo.update(req.params.id, pgData, workspaceId)
              : previousRow;
          if (!row) return res.status(404).json({ error: "Record not found" });
          const item = coerceBuiltIns(resource, pgToLegacy(row, resource));
          // Revisions and the field-level audit trail live in the JSON store
          // even for PG-backed records, so the /api/revisions view sees them.
          const revisionId = await mutateDb((db) => {
            const revId = recordRevision(
              db,
              resource,
              previous,
              item,
              req.user,
            );
            db.audit.unshift(
              auditEntry({
                action: `Updated ${resource.slice(0, -1)}`,
                actor: req.user.name,
                req,
                resourceId: req.params.id,
              }),
            );
            return revId;
          });
          if (revisionId) item.revisionId = revisionId;
          const event = updatedEvent(resource);
          if (event) triggerWorkflows(resource, event, item);
          broadcast("record.updated", { resource, item });
          cacheFlush(resource);
          return res.json(item);
        } catch (err) {
          return next(err);
        }
      }

      // ── Legacy JSON path ──────────────────────────────────────────────────
      let previous = null;
      let revisionId = null;
      const item = await mutateDb((db) => {
        const index = db[resource].findIndex((x) => x.id === req.params.id);
        if (index < 0) return null;
        previous = { ...db[resource][index] };
        const data = { ...req.body };
        db[resource][index] = {
          ...db[resource][index],
          ...coerceBuiltIns(resource, coerceCustomFields(db, resource, data)),
          id: db[resource][index].id,
          updatedAt: now(),
        };
        revisionId = recordRevision(
          db,
          resource,
          previous,
          db[resource][index],
          req.user,
        );
        db.audit.unshift(
          auditEntry({
            action: `Updated ${resource.slice(0, -1)}`,
            actor: req.user.name,
            req,
            resourceId: req.params.id,
          }),
        );
        return db[resource][index];
      });
      if (!item) return res.status(404).json({ error: "Record not found" });
      const event =
        eventFor(resource, previous, item) || updatedEvent(resource);
      if (event) triggerWorkflows(resource, event, item);
      broadcast("record.updated", { resource, item, revisionId });
      cacheFlush(resource);
      res.json(revisionId ? { ...item, revisionId } : item);
    },
    updateRecord,
  );

  app.patch(
    "/api/:resource/:id",
    auth,
    requireRole("admin", "member"),
    // This handler is registered before the partial-delta PATCH below, so it is
    // the one Express reaches first. The mask has to run here or a masked field
    // stays writable through the effective PATCH handler.
    checkWriteFieldMask(),
    validate(ResourceSchema),
    updateRecord,
  );

  app.patch(
    "/api/:resource/:id",
    auth,
    requireRole("admin", "member"),
    checkWriteFieldMask(),
    validate(ResourceSchema),
    async (req, res, next) => {
      const resource = req.params.resource;
      if (!resources.has(resource)) return next();

      // The body is a delta, not a replacement. partialDelta() is what makes
      // that true: it drops the server-owned fields (id, workspace,
      // createdAt/updatedAt) and every key the body did not mention, so nothing
      // downstream can read an absent key as "set it to null".
      const delta = partialDelta(req.body);

      // ── PG path ──────────────────────────────────────────────────────────
      if (PG_RESOURCES.has(resource)) {
        const repo = repoFor(resource);
        try {
          // `partial` skips the NOT NULL title fallback: that exists so a body
          // carrying only an invoice number can still be inserted, and on a
          // delta it would copy some other field over the stored title.
          const pgData = legacyToPg(delta, resource, { partial: true });
          coerceBuiltIns(resource, pgData);
          const tenant = tenantOf(req);
          // A PATCH with nothing in it is not a missing record. Read the row
          // back so an inline editor that submits an unchanged field still gets
          // the full state it expects to render.
          const row =
            Object.keys(pgData).length === 0
              ? await repo.findById(req.params.id, tenant)
              : await repo.update(req.params.id, pgData, tenant);
          if (!row) return res.status(404).json({ error: "Record not found" });
          const item = coerceBuiltIns(resource, pgToLegacy(row, resource));
          const event = updatedEvent(resource);
          if (event) triggerWorkflows(resource, event, item);
          broadcast("record.updated", { resource, item });
          cacheFlush(resource);
          return res.json(item);
        } catch (err) {
          return next(err);
        }
      }

      // ── Legacy JSON path ──────────────────────────────────────────────────
      let previous = null;
      let revisionId = null;
      const item = await mutateDb((db) => {
        const index = db[resource].findIndex((x) => x.id === req.params.id);
        if (index < 0) return null;
        previous = { ...db[resource][index] };
        const merged = applyPartialUpdate(
          db[resource][index],
          coerceBuiltIns(resource, coerceCustomFields(db, resource, delta)),
        );
        // Re-asserted rather than spread: the delta cannot carry them, but a
        // stored record that is missing one of them keeps the value it had.
        merged.id = db[resource][index].id;
        if (db[resource][index].createdAt !== undefined) {
          merged.createdAt = db[resource][index].createdAt;
        }
        merged.updatedAt = now();
        db[resource][index] = merged;
        revisionId = recordRevision(
          db,
          resource,
          previous,
          merged,
          req.user,
        );
        db.audit.unshift(auditEntry({
          action: `Updated ${resource.slice(0, -1)}`,
          actor: req.user.name,
          req,
          resourceId: req.params.id,
        }));
        return merged;
      });
      if (!item) return res.status(404).json({ error: "Record not found" });
      const event =
        eventFor(resource, previous, item) || updatedEvent(resource);
      if (event) triggerWorkflows(resource, event, item);
      broadcast("record.updated", { resource, item, revisionId });
      cacheFlush(resource);
      res.json(revisionId ? { ...item, revisionId } : item);
    },
  );

  /**
   * DELETE /api/:resource/:id
   * Admin/member. Deletes a record plus any derived data (calls: linked
   * activities/recordings; recordings: linked media; messages: linked
   * activities) and cleans up uploaded files. PostgreSQL-backed records are
   * tenant-scoped in SQL.
   * Path param: :id - record id
   * Response: 200 { ok: true } | 404 { error }
   */
  app.delete(
    "/api/:resource/:id",
    auth,
    requireRole("admin", "member"),
    async (req, res, next) => {
      const resource = req.params.resource;

      if (!resources.has(resource)) return next();

      // ── PG path ──────────────────────────────────────────────────────────
      if (PG_RESOURCES.has(resource)) {
        const repo = repoFor(resource);
        try {
          const deleted = await repo.delete(req.params.id, tenantOf(req));
          if (!deleted) return res.status(404).json({ error: "Record not found" });
          await mutateDb(db => {
            db.audit.unshift(auditEntry({ action: `Deleted ${resource.slice(0, -1)}`, actor: req.user.name, req, resourceId: req.params.id }));
          });
          broadcast("record.deleted", { resource, id: req.params.id });
          cacheFlush(resource);
          return res.json({ ok: true });
        } catch (err) {
          return next(err);
        }
      }

      // ── Legacy JSON path ──────────────────────────────────────────────────
      const result = await mutateDb((db) => {
        const index = db[resource].findIndex((x) => x.id === req.params.id);

        if (index < 0) return null;

        const [record] = db[resource].splice(index, 1);
        const files = [];

        if (resource === "calls") {
          db.activities = db.activities.filter(
            (item) => item.callId !== record.id,
          );

          const linked = db.recordings.filter(
            (item) => item.callId === record.id,
          );

          files.push(...linked.map((item) => item.fileUrl).filter(Boolean));

          db.recordings = db.recordings.filter(
            (item) => item.callId !== record.id,
          );
        }

        if (resource === "recordings") {
          if (record.fileUrl) {
            files.push(record.fileUrl);
          }

          if (record.callId) {
            const call = db.calls.find((item) => item.callId === record.id);

            if (call?.recordingId === record.id) {
              delete call.recordingId;
            }
          }
        }

        if (resource === "messages") {
          db.activities = db.activities.filter(
            (item) => item.messageId !== record.id,
          );
        }

        db.audit.unshift(
          auditEntry({
            action: `Deleted ${resource.slice(0, -1)}`,
            actor: req.user.name,
            req,
            resourceId: record.id,
          }),
        );

        return { files };
      });

      if (!result) {
        return res.status(404).json({
          error: "Record not found",
        });
      }

      await Promise.all(
        result.files.map(async (fileUrl) => {
          const name = path.basename(String(fileUrl));

          if (!name) return;

          try {
            await fs.unlink(path.join(uploadDir, name));
          } catch (error) {
            if (process.env.NODE_ENV !== "production") {
              console.warn("Failed to remove uploaded file", error.message);
            }
          }
        }),
      );
      broadcast(
        "record.deleted",
        { resource, id: req.params.id },
        req.user.workspaceId || "default",
      );
      cacheFlush(resource);

      res.json({ ok: true });
    },
  );
}
