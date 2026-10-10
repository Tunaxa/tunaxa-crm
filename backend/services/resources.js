import { mutateDb } from "../store.js";
import {
  auditEntry,
  coerceBuiltIns,
  coerceCustomFields,
  now,
  resources,
} from "../helpers.js";
import { PG_RESOURCES, legacyToPg, pgToLegacy } from "../db/legacy-shape.js";
import { repoFor } from "../db/repositories/index.js";
import { cacheFlush } from "./cache.js";
import { recordRevision } from "./revisions.js";
import {
  eventFor,
  triggerWorkflows,
  updatedEvent,
} from "./workflows.js";
import { broadcast } from "../routes/sse.js";

const SERVER_MANAGED_FIELDS = [
  "id",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "workspaceId",
  "workspace_id",
];

function editableFields(body) {
  const data = { ...body };
  for (const field of SERVER_MANAGED_FIELDS) delete data[field];
  return data;
}

export async function updateRecord(req, res, next) {
  const { resource, id } = req.params;
  if (!resources.has(resource)) return next();

  const data = editableFields(req.body || {});
  if (PG_RESOURCES.has(resource)) {
    try {
      const repo = repoFor(resource);
      const stored = await repo.findById(id);
      if (!stored) return res.status(404).json({ error: "Record not found" });
      const previous = pgToLegacy(stored, resource);
      const pgData = legacyToPg(data, resource);
      if (pgData.custom_fields) {
        pgData.custom_fields = { ...stored.custom_fields, ...pgData.custom_fields };
      }
      coerceBuiltIns(resource, pgData);
      const row =
        Object.keys(pgData).length > 0
          ? await repo.update(id, pgData)
          : await repo.findById(id);
      if (!row) return res.status(404).json({ error: "Record not found" });

      const item = pgToLegacy(row, resource);
      let revisionId = null;
      await mutateDb((db) => {
        revisionId = recordRevision(db, resource, previous, item, req.user);
        db.audit.unshift(auditEntry({
          action: `Updated ${resource.slice(0, -1)}`,
          actor: req.user.name,
          req,
          resourceId: id,
        }));
      });
      const event = updatedEvent(resource);
      if (event) triggerWorkflows(resource, event, item);
      broadcast("record.updated", { resource, item });
      await cacheFlush(resource);
      return res.json(revisionId ? { ...item, revisionId } : item);
    } catch (err) {
      return next(err);
    }
  }

  let previous = null;
  let revisionId = null;
  const item = await mutateDb((db) => {
    const index = db[resource].findIndex((record) => record.id === id);
    if (index < 0) return null;

    previous = { ...db[resource][index] };
    const customData = coerceCustomFields(db, resource, { ...data });
    coerceBuiltIns(resource, customData);
    const updated = {
      ...db[resource][index],
      ...customData,
      id: previous.id,
      createdAt: previous.createdAt,
      updatedAt: now(),
    };
    db[resource][index] = updated;
    revisionId = recordRevision(db, resource, previous, updated, req.user);
    db.audit.unshift(
      auditEntry({
        action: `Updated ${resource.slice(0, -1)}`,
        actor: req.user.name,
        req,
        resourceId: id,
      }),
    );
    return updated;
  });

  if (!item) return res.status(404).json({ error: "Record not found" });

  const event = eventFor(resource, previous, item) || updatedEvent(resource);
  if (event) triggerWorkflows(resource, event, item);
  broadcast("record.updated", { resource, item, revisionId }, req.user.workspaceId || "default");
  await cacheFlush(resource);
  return res.json(revisionId ? { ...item, revisionId } : item);
}
