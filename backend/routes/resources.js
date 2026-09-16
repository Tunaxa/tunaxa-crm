import path from "node:path";
import fs from "node:fs/promises";
import { readDb, mutateDb } from "../store.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import {
  id,
  now,
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
    let rows = db[req.params.resource] || [];
    const q = String(req.query.q || "")
      .toLowerCase()
      .trim();
    if (q)
      rows = rows.filter((item) =>
        JSON.stringify(item).toLowerCase().includes(q),
      );
    if (req.fieldPerms)
      rows = rows.map((item) => applyFieldMasking(item, req.fieldPerms));
    res.json(rows);
  });

  app.get("/api/:resource/:id", auth, async (req, res, next) => {
    if (!resources.has(req.params.resource)) return next();
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
          db.audit.unshift({
            id: id("audit"),
            action: `Created ${resource.slice(0, -1)}`,
            actor: req.user.name,
            createdAt,
          });
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
        db.audit.unshift({
          id: id("audit"),
          action: `Imported ${rows.length} ${resource}`,
          actor: req.user.name,
          createdAt: now(),
        });
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
        db.audit.unshift({
          id: id("audit"),
          action: `Updated ${resource.slice(0, -1)}`,
          actor: req.user.name,
          createdAt: now(),
        });
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
        db.audit.unshift({
          id: id("audit"),
          action: `Deleted ${resource.slice(0, -1)}`,
          actor: req.user.name,
          createdAt: now(),
        });
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
