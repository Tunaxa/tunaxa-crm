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
import {
  validate,
  ResourceSchema,
  BatchSchema,
} from "../services/validate.js";
import {
  triggerWorkflows,
  createdEvent,
  updatedEvent,
  eventFor,
} from "../services/workflows.js";
import { broadcast } from "./sse.js";
import { cacheFlush } from "../services/cache.js";
import { recordRevision } from "../services/revisions.js";
import {
  getFieldPermissions,
  applyFieldMasking,
} from "./permissions.js";
import { fileURLToPath } from "node:url";
import { repoFor } from "../db/repositories/index.js";
import {
  PG_RESOURCES,
  pgToLegacy,
  legacyToPg,
} from "../db/legacy-shape.js";

/**
 * Build a CSV representation of one row, quoting every cell.
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

  return columns.map((column) => cell(row[column])).join(",");
}

// Query parameters used as filters rather than pagination controls.
// Repositories ignore filters they do not support.
const PG_FILTER_KEYS = [
  "q",
  "type",
  "contact",
  "recordId",
  "stage",
  "status",
];

// Protect against unbounded page-through loops during CSV exports.
const MAX_PG_PAGES = 50;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function readPgFilters(query) {
  const filters = {};

  for (const key of PG_FILTER_KEYS) {
    if (query[key] !== undefined && query[key] !== "") {
      filters[key] = query[key];
    }
  }

  if (
    query.completed !== undefined &&
    query.completed !== ""
  ) {
    filters.completed = query.completed === "true";
  }

  return filters;
}

function readPagination(query = {}) {
  const requestedPage = Math.floor(Number(query.page) || 1);
  const requestedLimit = Math.floor(
    Number(query.limit) || DEFAULT_PAGE_SIZE,
  );

  return {
    page: Math.max(1, requestedPage),
    limit: Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, requestedLimit),
    ),
  };
}

/**
 * Fetch one page of a PostgreSQL resource.
 *
 * The API returns a paginated object so clients do not receive every row
 * when opening a list. Search, filters, sorting, counting and pagination
 * are applied by the repository on the server.
 */
async function pgFindAll(resource, query = {}) {
  const repo = repoFor(resource);
  const filters = readPgFilters(query);
  const pagination = readPagination(query);

  if (query.sortBy) {
    filters.sortBy = query.sortBy;
  }

  const result = await repo.findAll({
    ...filters,
    ...pagination,
  });

  return {
    data: result.data.map((row) => pgToLegacy(row, resource)),
    total: result.total,
    page: result.page,
    limit: result.limit,
    totalPages: result.totalPages,
    hasMore: result.page * result.limit < result.total,
  };
}

/**
 * Fetch PostgreSQL rows page by page for server-side CSV generation.
 * This helper is intentionally separate from the regular list endpoint.
 */
async function pgFindAllForExport(resource, query = {}) {
  const repo = repoFor(resource);
  const filters = readPgFilters(query);

  if (query.sortBy) {
    filters.sortBy = query.sortBy;
  }

  const rows = [];

  for (let page = 1; page <= MAX_PG_PAGES; page += 1) {
    const result = await repo.findAll({
      ...filters,
      page,
      limit: MAX_PAGE_SIZE,
    });

    rows.push(
      ...result.data.map((row) => pgToLegacy(row, resource)),
    );

    if (
      result.data.length === 0 ||
      rows.length >= result.total
    ) {
      break;
    }
  }

  return rows;
}

const root = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(root, "..", "uploads");

// Fields the client may never overwrite.
const IMMUTABLE_FIELDS = ["id", "createdAt"];

export default function registerResourceRoutes(app) {
  app.use("/api/:resource", async (req, res, next) => {
    if (!resources.has(req.params.resource) || !req.user) {
      return next();
    }

    req.db = await readDb();

    req.fieldPerms = getFieldPermissions(
      req.db,
      req.params.resource.replace(/s$/, ""),
      req.user.role,
    );

    next();
  });

  app.get("/api/:resource", auth, async (req, res, next) => {
    if (!resources.has(req.params.resource)) {
      return next();
    }

    // PostgreSQL resources: return a single server-paginated page.
    if (PG_RESOURCES.has(req.params.resource)) {
      try {
        const result = await pgFindAll(
          req.params.resource,
          req.query,
        );

        return res.json(result);
      } catch (err) {
        return next(err);
      }
    }

    // Legacy JSON resources.
    const db = req.db || (await readDb());

    const page = Math.max(
      1,
      Math.floor(Number(req.query.page) || 1),
    );

    const limit = Math.min(
      50,
      Math.max(
        1,
        Math.floor(Number(req.query.limit) || DEFAULT_PAGE_SIZE),
      ),
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
        const directTypes = [
          "email",
          "call",
          "meeting",
          "note",
        ];

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

    // AXA-128: only return email messages when type=email is requested.
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

    const total = rows.length;
    const paginatedRows = rows.slice(start, start + limit);

    return res.json({
      data: paginatedRows,
      total,
      page,
      limit,
      hasMore: start + limit < total,
    });
  });

  app.get(
    "/api/:resource/export.csv",
    auth,
    async (req, res, next) => {
      if (!resources.has(req.params.resource)) {
        return next();
      }

      let rows;

      if (PG_RESOURCES.has(req.params.resource)) {
        try {
          rows = await pgFindAllForExport(
            req.params.resource,
            req.query,
          );
        } catch (err) {
          return next(err);
        }
      } else {
        const db = req.db || (await readDb());

        rows = (db[req.params.resource] || []).map((item) =>
          req.fieldPerms
            ? applyFieldMasking(item, req.fieldPerms)
            : item,
        );
      }

      const columns = [
        ...new Set(rows.flatMap((row) => Object.keys(row))),
      ];

      const header = Object.fromEntries(
        columns.map((column) => [column, column]),
      );

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${req.params.resource}.csv"`,
      );

      res.write(`${buildCsvRow(columns, header)}\r\n`);

      for (const row of rows) {
        res.write(`${buildCsvRow(columns, row)}\r\n`);
      }

      res.end();
    },
  );

  app.get("/api/:resource/:id", auth, async (req, res, next) => {
    if (!resources.has(req.params.resource)) {
      return next();
    }

    // PostgreSQL resource.
    if (PG_RESOURCES.has(req.params.resource)) {
      const repo = repoFor(req.params.resource);

      try {
        const row = await repo.findById(req.params.id);

        if (!row) {
          return res.status(404).json({
            error: "Record not found",
          });
        }

        return res.json(
          pgToLegacy(row, req.params.resource),
        );
      } catch (err) {
        return next(err);
      }
    }

    // Legacy JSON resource.
    const db = req.db || (await readDb());
    const rows = db[req.params.resource] || [];
    const item = rows.find((row) => row.id === req.params.id);

    if (!item) {
      return res.status(404).json({
        error: "Record not found",
      });
    }

    return res.json(
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

      if (!resources.has(resource)) {
        return next();
      }

      // PostgreSQL resource.
      if (PG_RESOURCES.has(resource)) {
        const repo = repoFor(resource);

        try {
          const pgData = legacyToPg(
            { ...req.body },
            resource,
          );

          coerceBuiltIns(resource, pgData);

          const row = await repo.create(pgData);
          const item = pgToLegacy(row, resource);
          const event = createdEvent(resource);

          if (event) {
            triggerWorkflows(resource, event, item);
          }

          broadcast("record.created", { resource, item });
          cacheFlush(resource);

          return res.status(201).json(item);
        } catch (err) {
          return next(err);
        }
      }

      // Legacy JSON resource.
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

      if (event) {
        triggerWorkflows(resource, event, item);
      }

      broadcast(
        "record.created",
        { resource, item },
        req.user.workspaceId || "default",
      );

      cacheFlush(resource);

      return res.status(201).json(item);
    },
  );

  app.post(
    "/api/:resource/batch",
    auth,
    requireRole("admin", "member"),
    validate(BatchSchema),
    async (req, res, next) => {
      const resource = req.params.resource;

      if (!resources.has(resource)) {
        return next();
      }

      // PostgreSQL resource.
      if (PG_RESOURCES.has(resource)) {
        const repo = repoFor(resource);

        try {
          const saved = await Promise.all(
            req.body.map(async (data) => {
              const pgData = legacyToPg(
                { ...data },
                resource,
              );

              coerceBuiltIns(resource, pgData);

              const row = await repo.create(pgData);
              return pgToLegacy(row, resource);
            }),
          );

          broadcast(
            "records.batch",
            { resource, count: saved.length },
          );

          cacheFlush(resource);

          return res.status(201).json(saved);
        } catch (err) {
          return next(err);
        }
      }

      // Legacy JSON resource.
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

      return res.status(201).json(saved);
    },
  );

  // PUT and PATCH share the same update implementation.
  const updateRecord = async (req, res, next) => {
    const resource = req.params.resource;

    if (!resources.has(resource)) {
      return next();
    }

    let previous = null;
    let revisionId = null;

    // PostgreSQL resource.
    if (PG_RESOURCES.has(resource)) {
      const repo = repoFor(resource);

      try {
        const pgData = legacyToPg(
          { ...req.body },
          resource,
        );

        coerceBuiltIns(resource, pgData);

        const row = await repo.update(
          req.params.id,
          pgData,
        );

        if (!row) {
          return res.status(404).json({
            error: "Record not found",
          });
        }

        const item = pgToLegacy(row, resource);
        const event = updatedEvent(resource);

        if (event) {
          triggerWorkflows(resource, event, item);
        }

        broadcast("record.updated", { resource, item });
        cacheFlush(resource);

        return res.json(item);
      } catch (err) {
        return next(err);
      }
    }

    // Legacy JSON resource.
    const item = await mutateDb((db) => {
      const index = db[resource].findIndex(
        (row) => row.id === req.params.id,
      );

      if (index < 0) {
        return null;
      }

      previous = { ...db[resource][index] };

      const data = { ...req.body };

      for (const field of IMMUTABLE_FIELDS) {
        delete data[field];
      }

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

    if (event) {
      triggerWorkflows(resource, event, item);
    }

    broadcast(
      "record.updated",
      { resource, item, revisionId },
      req.user.workspaceId || "default",
    );

    cacheFlush(resource);

    return res.json(
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

      if (!resources.has(resource)) {
        return next();
      }

      // PostgreSQL resource.
      if (PG_RESOURCES.has(resource)) {
        const repo = repoFor(resource);

        try {
          const deleted = await repo.delete(req.params.id);

          if (!deleted) {
            return res.status(404).json({
              error: "Record not found",
            });
          }

          broadcast(
            "record.deleted",
            { resource, id: req.params.id },
          );

          cacheFlush(resource);

          return res.json({ ok: true });
        } catch (err) {
          return next(err);
        }
      }

      // Legacy JSON resource.
      const result = await mutateDb((db) => {
        const index = db[resource].findIndex(
          (row) => row.id === req.params.id,
        );

        if (index < 0) {
          return null;
        }

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

          if (!name) {
            return;
          }

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

      broadcast(
        "record.deleted",
        { resource, id: req.params.id },
        req.user.workspaceId || "default",
      );

      cacheFlush(resource);

      return res.json({ ok: true });
    },
  );
}