import path from "node:path";
import fs from "node:fs/promises";
import { readDb, mutateDb } from "../store.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import {
  id,
  now,
  auditEntry,
  coerceBuiltIns,
  coerceCustomFields,
  resources,
} from "../helpers.js";
import { validate, ResourceSchema, BatchSchema } from "../services/validate.js";
import {
  triggerWorkflows,
  createdEvent,
  updatedEvent,
  eventFor,
} from "../services/workflows.js";
import { broadcast } from "./sse.js";
import { cacheFlush } from "../services/cache.js";
import { recordRevision } from "../services/revisions.js";
import { getFieldPermissions, applyFieldMasking } from "./permissions.js";
import { fileURLToPath } from "node:url";
import { repoFor } from "../db/repositories/index.js";
import { PG_RESOURCES, pgToLegacy, legacyToPg } from "../db/legacy-shape.js";

/**
 * Build the CSV representation of a single row, quoting every cell.
 */
function buildCsvRow(columns, row) {
  const cell = (value) => {
    const text =
      value == null
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };
  return columns.map((col) => cell(row[col])).join(",");
}

// Query params that are filters rather than paging controls. The legacy JSON
// path applied these in JS after loading the whole file; forwarding them to the
// repository keeps the same results while pushing the work into SQL. Repos
// ignore the keys they do not implement.
const PG_FILTER_KEYS = ["q", "type", "contact", "recordId", "stage", "status"];

// Hard stop on page-through loops. A repository that reports a total it cannot
// deliver would otherwise spin until the request times out.
const MAX_PG_PAGES = 50;

function readPgFilters(query) {
  const filters = {};
  for (const key of PG_FILTER_KEYS) {
    if (query[key] !== undefined && query[key] !== "") filters[key] = query[key];
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
async function pgFindAll(resource, query = {}) {
  const repo = repoFor(resource);
  const filters = readPgFilters(query);
  if (query.sortBy) filters.sortBy = query.sortBy;

  const hasPaging = query.page !== undefined || query.limit !== undefined;
  if (hasPaging) {
    filters.page = Number(query.page) || 1;
    filters.limit = Number(query.limit) || 20;
    const result = await repo.findAll(filters);
    return result.data.map((row) => pgToLegacy(row, resource));
  }

  const rows = [];
  for (let page = 1; page <= MAX_PG_PAGES; page++) {
    const result = await repo.findAll({ ...filters, page, limit: 100 });
    rows.push(...result.data.map((row) => pgToLegacy(row, resource)));
    if (result.data.length === 0 || rows.length >= result.total) break;
  }
  return rows;
}

const root = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(root, "..", "uploads");

// Fields the client may never set when updating a record: the stored values
// always win. Stripped from the payload rather than re-pinned after the merge,
// so there is a single mechanism to reason about.
const IMMUTABLE_FIELDS = ["id", "createdAt"];

export default function registerResourceRoutes(app) {
  app.use("/api/:resource", async (req, res, next) => {
    if (!resources.has(req.params.resource) || !req.user) return next();

    req.db = await readDb();
    req.fieldPerms = getFieldPermissions(
      req.db,
      req.params.resource.replace(/s$/, ""),
      req.user.role,
    );

    next();
  });

  app.get("/api/:resource", auth, async (req, res, next) => {
    if (!resources.has(req.params.resource)) return next();

    // ── PG path: every resource in PG_RESOURCES ────────────────────────────
    if (PG_RESOURCES.has(req.params.resource)) {
      try {
        const rows = await pgFindAll(req.params.resource, req.query);
        return res.json(rows);
      } catch (err) {
        return next(err);
      }
    }

    // ── Legacy JSON path: all other resources ──────────────────────────────
    const db = req.db || (await readDb());

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(
      50,
      Math.max(1, Number(req.query.limit) || 20),
    );
    const start = (page - 1) * limit;

    let rows = db[req.params.resource] || [];

    const q = String(req.query.q || "")
      .toLowerCase()
      .trim();

    if (q) {
      rows = rows.filter((item) =>
        JSON.stringify(item).toLowerCase().includes(q),
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
          (item) =>
            String(item.channel || "").toLowerCase() === "email",
        );
      }
    }

    if (req.fieldPerms) {
      rows = rows.map((item) =>
        applyFieldMasking(item, req.fieldPerms),
      );
    }

    // AXA-128: pagination for messages
    if (req.params.resource === "messages") {
      const total = rows.length;
      const paginatedRows = rows.slice(start, start + limit);

      return res.json({
        items: paginatedRows,
        total,
        page,
        limit,
        hasMore: start + limit < total,
      });
    }

    res.json(rows);
  });


  app.get("/api/:resource/export.csv", auth, async (req, res, next) => {
    if (!resources.has(req.params.resource)) return next();

    const db = req.db || (await readDb());

    const rows = (db[req.params.resource] || []).map((item) =>
      req.fieldPerms ? applyFieldMasking(item, req.fieldPerms) : item,
    );

    const columns = [
      ...new Set(rows.flatMap((row) => Object.keys(row))),
    ];

    const cell = (value) => {
      const text =
        value == null
          ? ""
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);

      return `"${text.replace(/"/g, '""')}"`;
    };

    let rows;
    if (PG_RESOURCES.has(req.params.resource)) {
      try {
        // Already legacy-shaped by the time it gets here, so the header keeps
        // the same camelCase names the JSON-backed exports have always used.
        rows = await pgFindAll(req.params.resource, {});
      } catch (err) {
        return next(err);
      }
    } else {
      const db = req.db || (await readDb());
      rows = (db[req.params.resource] || []).map((item) =>
        req.fieldPerms ? applyFieldMasking(item, req.fieldPerms) : item,
      );
    }

    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    // buildCsvRow indexes by column name, so the header is the same shape with
    // each column named after itself.
    const header = Object.fromEntries(columns.map((column) => [column, column]));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.resource}.csv"`);
    res.write(`${buildCsvRow(columns, header)}\r\n`);
    for (const row of rows) {
      res.write(`${buildCsvRow(columns, row)}\r\n`);
    }

    res.end();
  });

  app.get("/api/:resource/:id", auth, async (req, res, next) => {
    if (!resources.has(req.params.resource)) return next();

    // ── PG path ───────────────────────────────────────────────────────────
    if (PG_RESOURCES.has(req.params.resource)) {
      const repo = repoFor(req.params.resource);
      try {
        const row = await repo.findById(req.params.id);
        if (!row) return res.status(404).json({ error: "Record not found" });
        return res.json(pgToLegacy(row, req.params.resource));
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

    res.json(
      req.fieldPerms
        ? applyFieldMasking(item, req.fieldPerms)
        : item,
    );
  });

  app.post(
    "/api/:resource",
    auth,
    requireRole("admin", "member"),
    validate(ResourceSchema),
    async (req, res, next) => {
      const resource = req.params.resource;

      if (!resources.has(resource)) return next();

      // ── PG path ──────────────────────────────────────────────────────────
      if (PG_RESOURCES.has(resource)) {
        const repo = repoFor(resource);
        try {
          const pgData = legacyToPg({ ...req.body }, resource);
          // Coerce numeric built-ins (e.g. deals.value, companies.employees)
          coerceBuiltIns(resource, pgData);
          const row = await repo.create(pgData);
          const item = pgToLegacy(row, resource);
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
          ...coerceBuiltIns(
            resource,
            coerceCustomFields(db, resource, data),
          ),
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
      broadcast("record.created", { resource, item }, req.user.workspaceId || "default");
      cacheFlush(resource);

      res.status(201).json(item);
    },
  );

  app.post(
    "/api/:resource/batch",
    auth,
    requireRole("admin", "member"),
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
      broadcast("records.batch", { resource, count: saved.length }, req.user.workspaceId || "default");
      cacheFlush(resource);

      res.status(201).json(saved);
    },
  );

  // PUT and PATCH are the same operation in this store. The payload is merged
  // over the stored record rather than replacing it, so a client that sends only
  // the fields it changed (inline editing) leaves every other field untouched.
  const updateRecord = async (req, res, next) => {
    const resource = req.params.resource;

    if (!resources.has(resource)) return next();

    let previous = null;
    let revisionId = null;
      // ── PG path ──────────────────────────────────────────────────────────
      if (PG_RESOURCES.has(resource)) {
        const repo = repoFor(resource);
        try {
          const pgData = legacyToPg({ ...req.body }, resource);
          coerceBuiltIns(resource, pgData);
          const row = await repo.update(req.params.id, pgData);
          if (!row) return res.status(404).json({ error: "Record not found" });
          const item = pgToLegacy(row, resource);
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
      const index = db[resource].findIndex(
        (x) => x.id === req.params.id,
      );

      if (index < 0) return null;

      previous = { ...db[resource][index] };

      const data = { ...req.body };

      for (const field of IMMUTABLE_FIELDS) delete data[field];

      db[resource][index] = {
        ...db[resource][index],
        ...coerceBuiltIns(
          resource,
          coerceCustomFields(db, resource, data),
        ),
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

    if (!item) {
      return res.status(404).json({
        error: "Record not found",
      });
    }

    const event =
      eventFor(resource, previous, item) || updatedEvent(resource);
    if (event) triggerWorkflows(resource, event, item);
    broadcast("record.updated", { resource, item, revisionId }, req.user.workspaceId || "default");
    cacheFlush(resource);

    res.json(
      revisionId
        ? { ...item, revisionId }
        : item,
    );
  };

  app.put(
    "/api/:resource/:id",
    auth,
    requireRole("admin", "member"),
    validate(ResourceSchema),
    updateRecord,
  );

  app.patch(
    "/api/:resource/:id",
    auth,
    requireRole("admin", "member"),
    validate(ResourceSchema),
    updateRecord,
  );

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
          const deleted = await repo.delete(req.params.id);
          if (!deleted) return res.status(404).json({ error: "Record not found" });
          broadcast("record.deleted", { resource, id: req.params.id });
          cacheFlush(resource);
          return res.json({ ok: true });
        } catch (err) {
          return next(err);
        }
      }

      // ── Legacy JSON path ──────────────────────────────────────────────────
      const result = await mutateDb((db) => {
        const index = db[resource].findIndex(
          (x) => x.id === req.params.id,
        );

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

          files.push(
            ...linked
              .map((item) => item.fileUrl)
              .filter(Boolean),
          );

          db.recordings = db.recordings.filter(
            (item) => item.callId !== record.id,
          );
        }

        if (resource === "recordings") {
          if (record.fileUrl) {
            files.push(record.fileUrl);
          }

          if (record.callId) {
            const call = db.calls.find(
              (item) => item.callId === record.id,
            );

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
              console.warn(
                "Failed to remove uploaded file",
                error.message,
              );
            }
          }
        }),
      );
      broadcast("record.deleted", { resource, id: req.params.id }, req.user.workspaceId || "default");
      cacheFlush(resource);

      res.json({ ok: true });
    },
  );
}