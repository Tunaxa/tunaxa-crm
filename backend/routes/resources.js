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
import * as contactsRepo from "../db/repositories/contacts.js";
import * as leadsRepo from "../db/repositories/leads.js";
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

/**
 * Fetch all rows from a PG resource (contacts or leads) as a plain legacy
 * array, passing `q` for server-side search.
 */
async function pgFindAll(resource, query = {}) {
  const repo = resource === "contacts" ? contactsRepo : leadsRepo;
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 1000; // large default → return "all"
  const q = query.q || "";
  const sortBy = query.sortBy || "created_at:desc";
  const result = await repo.findAll({ page, limit, q, sortBy });
  return result.data.map(pgToLegacy);
}

const root = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(root, "..", "uploads");

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

    // ── PG path: contacts / leads ──────────────────────────────────────────
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
    let rows = db[req.params.resource] || [];
    const q = String(req.query.q || "")
      .toLowerCase()
      .trim();
    if (q)
      rows = rows.filter((item) =>
        JSON.stringify(item).toLowerCase().includes(q),
      );
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
      const contact = String(req.query.contact || "").trim().toLowerCase();
      if (recordId || contact) {
        rows = rows.filter((item) =>
          (recordId && item.recordId === recordId) ||
          (contact && (
            String(item.contact || "").toLowerCase() === contact ||
            String(item.company || "").toLowerCase() === contact ||
            String(item.title || "").toLowerCase().includes(contact)
          )),
        );
      }
    }
    if (req.fieldPerms)
      rows = rows.map((item) => applyFieldMasking(item, req.fieldPerms));
    res.json(rows);
  });


  app.get("/api/:resource/export.csv", auth, async (req, res, next) => {
    if (!resources.has(req.params.resource)) return next();

    let rows;
    if (PG_RESOURCES.has(req.params.resource)) {
      try {
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

    const cell = (value) => {
      const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
      return `"${text.replace(/"/g, '""')}"`;
    };
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.resource}.csv"`);
    res.write(`${columns.map(cell).join(",")}\r\n`);
    for (const row of rows) {
      res.write(`${columns.map((column) => cell(row[column])).join(",")}\r\n`);
    }
    res.end();
  });

  app.get("/api/:resource/:id", auth, async (req, res, next) => {
    if (!resources.has(req.params.resource)) return next();

    // ── PG path ───────────────────────────────────────────────────────────
    if (PG_RESOURCES.has(req.params.resource)) {
      const repo = req.params.resource === "contacts" ? contactsRepo : leadsRepo;
      try {
        const row = await repo.findById(req.params.id);
        if (!row) return res.status(404).json({ error: "Record not found" });
        return res.json(pgToLegacy(row));
      } catch (err) {
        return next(err);
      }
    }

    // ── Legacy JSON path ──────────────────────────────────────────────────
    const db = req.db || (await readDb());
    const rows = db[req.params.resource] || [];
    const item = rows.find((x) => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Record not found" });
    res.json(req.fieldPerms ? applyFieldMasking(item, req.fieldPerms) : item);
  });

  app.post(
    "/api/:resource",
    auth,
    requireRole("admin", "member"),
    validate(ResourceSchema),
    async (req, res, next) => {
      const resource = req.params.resource;
      if (!resources.has(resource)) return next();

      // ── PG path: contacts / leads ────────────────────────────────────────
      if (PG_RESOURCES.has(resource)) {
        const repo = resource === "contacts" ? contactsRepo : leadsRepo;
        try {
          const pgData = legacyToPg({ ...req.body });
          // Coerce numeric built-ins (e.g. value)
          coerceBuiltIns(resource, pgData);
          const row = await repo.create(pgData);
          const item = pgToLegacy(row);
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
            title: `${record.channel || "Message"} to ${record.to || "recipient"}`,
            type: record.channel || "Email",
            contact: record.to || "",
            notes: record.subject || record.body || "",
            date: createdAt.slice(0, 10),
            messageId: record.id,
            createdAt,
            updatedAt: createdAt,
          });
        }
        if (resource !== "audit")
          db.audit.unshift(auditEntry({
            action: `Created ${resource.slice(0, -1)}`,
            actor: req.user.name,
            createdAt,
            req,
            resourceId: record.id,
          }));
        return record;
      });
      const event = createdEvent(resource);
      if (event) triggerWorkflows(resource, event, item);
      broadcast("record.created", { resource, item });
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

      // ── PG path: contacts / leads ────────────────────────────────────────
      if (PG_RESOURCES.has(resource)) {
        const repo = resource === "contacts" ? contactsRepo : leadsRepo;
        try {
          const saved = await Promise.all(
            req.body.map(async (data) => {
              const pgData = legacyToPg({ ...data });
              coerceBuiltIns(resource, pgData);
              const row = await repo.create(pgData);
              return pgToLegacy(row);
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
        db.audit.unshift(auditEntry({
          action: `Imported ${rows.length} ${resource}`,
          actor: req.user.name,
          req,
          resourceId: rows.map((row) => row.id).join(","),
        }));
        return rows;
      });
      broadcast("records.batch", { resource, count: saved.length });
      cacheFlush(resource);
      res.status(201).json(saved);
    },
  );

  app.put(
    "/api/:resource/:id",
    auth,
    requireRole("admin", "member"),
    validate(ResourceSchema),
    async (req, res, next) => {
      const resource = req.params.resource;
      if (!resources.has(resource)) return next();

      // ── PG path: contacts / leads ────────────────────────────────────────
      if (PG_RESOURCES.has(resource)) {
        const repo = resource === "contacts" ? contactsRepo : leadsRepo;
        try {
          const pgData = legacyToPg({ ...req.body });
          coerceBuiltIns(resource, pgData);
          const row = await repo.update(req.params.id, pgData);
          if (!row) return res.status(404).json({ error: "Record not found" });
          const item = pgToLegacy(row);
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
        db.audit.unshift(auditEntry({
          action: `Updated ${resource.slice(0, -1)}`,
          actor: req.user.name,
          req,
          resourceId: req.params.id,
        }));
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
  );

  app.delete(
    "/api/:resource/:id",
    auth,
    requireRole("admin", "member"),
    async (req, res, next) => {
      const resource = req.params.resource;
      if (!resources.has(resource)) return next();

      // ── PG path: contacts / leads ────────────────────────────────────────
      if (PG_RESOURCES.has(resource)) {
        const repo = resource === "contacts" ? contactsRepo : leadsRepo;
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
          if (record.fileUrl) files.push(record.fileUrl);
          if (record.callId) {
            const call = db.calls.find((item) => item.id === record.callId);
            if (call?.recordingId === record.id) delete call.recordingId;
          }
        }
        if (resource === "messages")
          db.activities = db.activities.filter(
            (item) => item.messageId !== record.id,
          );
        db.audit.unshift(auditEntry({
          action: `Deleted ${resource.slice(0, -1)}`,
          actor: req.user.name,
          req,
          resourceId: record.id,
        }));
        return { files };
      });
      if (!result) return res.status(404).json({ error: "Record not found" });
      await Promise.all(
        result.files.map(async (fileUrl) => {
          const name = path.basename(String(fileUrl));
          if (!name) return;
          try {
            await fs.unlink(path.join(uploadDir, name));
          } catch (error) {
            if (process.env.NODE_ENV !== "production")
              console.warn("Failed to remove uploaded file", error.message);
          }
        }),
      );
      broadcast("record.deleted", { resource, id: req.params.id });
      cacheFlush(resource);
      res.json({ ok: true });
    },
  );
}
