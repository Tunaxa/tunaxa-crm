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

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${req.params.resource}.csv"`,
    );

    res.write(`${columns.map(cell).join(",")}\r\n`);

    for (const row of rows) {
      res.write(
        `${columns.map((column) => cell(row[column])).join(",")}\r\n`,
      );
    }

    res.end();
  });

  // Bulk batch operations (must be registered before /:id routes)
  app.patch(
    "/api/:resource/batch",
    auth,
    requireRole("admin", "member"),
    async (req, res, next) => {
      if (!resources.has(req.params.resource)) return next();
      const resource = req.params.resource;
      const { ids, data } = req.body || {};

      if (!ids || !Array.isArray(ids) || ids.length < 1 || ids.length > 100) {
        return res.status(400).json({
          error: "ids must be an array containing between 1 and 100 items",
        });
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return res.status(400).json({ error: "data must be an object" });
      }

      const IMMUTABLE_FIELDS = new Set(["id", "createdAt"]);
      const update = {};
      for (const key of Object.keys(data)) {
        if (!IMMUTABLE_FIELDS.has(key)) update[key] = data[key];
      }

      const errors = [];
      const success = [];

      await mutateDb((db) => {
        const rows = db[resource] || [];
        for (let i = 0; i < ids.length; i++) {
          const idVal = ids[i];
          const idxRec = rows.findIndex((x) => x.id === idVal);
          if (idxRec < 0) {
            errors.push({ id: idVal, reason: "Record not found" });
            continue;
          }
          const previous = { ...rows[idxRec] };
          const merged = {
            ...rows[idxRec],
            ...coerceBuiltIns(
              resource,
              coerceCustomFields(db, resource, { ...update }),
            ),
            updatedAt: now(),
          };
          rows[idxRec] = merged;
          const revisionId = recordRevision(db, resource, previous, merged, req.user);
          success.push({ id: idVal, revisionId });
          db.audit.unshift(
            auditEntry({
              action: `Updated ${resource.slice(0, -1)}` + (ids.length > 1 ? " (batch)" : ""),
              actor: req.user.name,
              req,
              resourceId: idVal,
            }),
          );
        }
      });

      if (success.length) {
        cacheFlush(resource);
        for (const s of success) {
          broadcast(
            "record.updated",
            { resource, item: undefined, id: s.id, revisionId: s.revisionId },
            req.user.workspaceId || "default",
          );
        }
        broadcast(
          "records.batch",
          { resource, count: success.length, operation: "patch" },
          req.user.workspaceId || "default",
        );
      }

      const status = errors.length === 0 ? 200 : errors.length === ids.length ? 400 : 207;
      res.status(status).json({
        successCount: success.length,
        errorCount: errors.length,
        errors,
      });
    },
  );

  app.delete(
    "/api/:resource/batch",
    auth,
    requireRole("admin", "member"),
    async (req, res, next) => {
      if (!resources.has(req.params.resource)) return next();
      const resource = req.params.resource;
      const { ids } = req.body || {};

      if (!ids || !Array.isArray(ids) || ids.length < 1 || ids.length > 100) {
        return res.status(400).json({
          error: "ids must be an array containing between 1 and 100 items",
        });
      }

      const errors = [];
      const success = [];

      await mutateDb((db) => {
        const rows = db[resource] || [];
        for (let i = 0; i < ids.length; i++) {
          const idVal = ids[i];
          const idxRec = rows.findIndex((x) => x.id === idVal);
          if (idxRec < 0) {
            errors.push({ id: idVal, reason: "Record not found" });
            continue;
          }
          const [record] = rows.splice(idxRec, 1);
          success.push({ id: idVal });
          db.audit.unshift(
            auditEntry({
              action: `Deleted ${resource.slice(0, -1)}` + (ids.length > 1 ? " (batch)" : ""),
              actor: req.user.name,
              req,
              resourceId: idVal,
            }),
          );
          // file cleanup omitted for batch (matches single record patterns elsewhere); keep minimal
        }
      });

      if (success.length) {
        cacheFlush(resource);
        for (const s of success) {
          broadcast("record.deleted", { resource, id: s.id }, req.user.workspaceId || "default");
        }
        broadcast(
          "records.batch",
          { resource, count: success.length, operation: "delete" },
          req.user.workspaceId || "default",
        );
      }

      const status = errors.length === 0 ? 200 : errors.length === ids.length ? 400 : 207;
      res.status(status).json({
        successCount: success.length,
        errorCount: errors.length,
        errors,
      });
    },
  );

  app.get("/api/:resource/:id", auth, async (req, res, next) => {
    if (!resources.has(req.params.resource)) return next();

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

  app.put(
    "/api/:resource/:id",
    auth,
    requireRole("admin", "member"),
    validate(ResourceSchema),
    async (req, res, next) => {
      const resource = req.params.resource;

      if (!resources.has(resource)) return next();

      let previous = null;
      let revisionId = null;

      const item = await mutateDb((db) => {
        const index = db[resource].findIndex(
          (x) => x.id === req.params.id,
        );

        if (index < 0) return null;

        previous = { ...db[resource][index] };

        const data = { ...req.body };

        db[resource][index] = {
          ...db[resource][index],
          ...coerceBuiltIns(
            resource,
            coerceCustomFields(db, resource, data),
          ),
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
    },
  );

  app.delete(
    "/api/:resource/:id",
    auth,
    requireRole("admin", "member"),
    async (req, res, next) => {
      const resource = req.params.resource;

      if (!resources.has(resource)) return next();

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