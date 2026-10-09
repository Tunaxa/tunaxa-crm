import { readDb, mutateDb } from "../store.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { id, now } from "../helpers.js";
import { broadcast } from "./sse.js";
import {
  normalizeListQuery,
  buildPaginationEnvelope,
  sortRecords,
  wantsEnvelope,
} from "../middleware/pagination.js";

// A stage is `{ key, label, probability, order }`. Accept a few aliases so the
// endpoint is forgiving of clients that send `name`/`stage` instead.
export function normalizeStages(stages) {
  if (!Array.isArray(stages)) return [];
  return stages
    .filter((stage) => stage && typeof stage === "object")
    .map((stage, index) => ({
      key: String(stage.key ?? stage.stage ?? stage.name ?? `stage_${index + 1}`),
      label: String(stage.label ?? stage.name ?? stage.key ?? `Stage ${index + 1}`),
      probability: Number(stage.probability ?? 0) || 0,
      order: Number.isFinite(Number(stage.order)) ? Number(stage.order) : index,
    }))
    .sort((a, b) => a.order - b.order);
}

/**
 * Resolve the pipeline a deal belongs to. Falls back to the primary (first)
 * defined pipeline when the deal has no `pipelineId`, so downstream reads always
 * have a pipeline to group by.
 */
export function resolvePipelineDefinition(db, pipelineId) {
  const list = Array.isArray(db.pipelineDefinitions)
    ? db.pipelineDefinitions
    : [];
  if (pipelineId) {
    const match = list.find((pipeline) => pipeline.id === pipelineId);
    if (match) return match;
  }
  return list[0] || null;
}

/**
 * The primary pipeline is simply the first definition created. Used to default
 * deals that do not name a pipeline explicitly.
 */
export function primaryPipelineId(db) {
  const primary = resolvePipelineDefinition(db, null);
  return primary ? primary.id : null;
}

export default function registerPipelineDefinitionRoutes(app) {
  // Multiple pipelines: a workspace can hold more than one definition, each with
  // its own set of stages. Deals reference one via `pipelineId`.
  app.get("/api/pipeline/definitions", auth, async (req, res) => {
    const db = await readDb();
    let list = Array.isArray(db.pipelineDefinitions)
      ? db.pipelineDefinitions
      : [];

    const { page, limit, sortBy, sortDir } = normalizeListQuery(req.query);
    if (req.query.sortBy !== undefined || req.query.sortDir !== undefined) {
      list = sortRecords(list, sortBy, sortDir);
    }

    // Bare GET stays a plain array for existing clients; `?envelope=true`
    // opts into the uniform paged shape (see docs/api-query-params.md).
    if (wantsEnvelope(req.query)) {
      const start = (page - 1) * limit;
      return res.json(
        buildPaginationEnvelope(list.slice(start, start + limit), list.length, {
          page,
          limit,
        }),
      );
    }

    res.json(list);
  });

  app.get("/api/pipeline/definitions/:id", auth, async (req, res) => {
    const db = await readDb();
    const found = (db.pipelineDefinitions || []).find(
      (pipeline) => pipeline.id === req.params.id,
    );
    if (!found) return res.status(404).json({ error: "Pipeline not found" });
    res.json(found);
  });

  app.post(
    "/api/pipeline/definitions",
    auth,
    requireRole("admin", "member"),
    async (req, res) => {
      const { name, stages } = req.body || {};
      if (!name || typeof name !== "string") {
        return res.status(400).json({ error: "name is required" });
      }
      const saved = await mutateDb((db) => {
        if (!Array.isArray(db.pipelineDefinitions)) db.pipelineDefinitions = [];
        const createdAt = now();
        const pipeline = {
          id: id("pipeline"),
          name,
          stages: normalizeStages(stages),
          createdAt,
          updatedAt: createdAt,
        };
        db.pipelineDefinitions.push(pipeline);
        if (Array.isArray(db.audit)) {
          db.audit.unshift({
            id: id("audit"),
            action: `Created pipeline definition "${name}"`,
            actor: req.user.name,
            createdAt,
            resourceId: pipeline.id,
          });
        }
        return pipeline;
      });
      broadcast(
        "pipeline.definition_created",
        saved,
        req.user.workspaceId || "default",
      );
      res.status(201).json(saved);
    },
  );

  app.put(
    "/api/pipeline/definitions/:id",
    auth,
    requireRole("admin", "member"),
    async (req, res) => {
      const body = req.body || {};
      const saved = await mutateDb((db) => {
        const found = (db.pipelineDefinitions || []).find(
          (pipeline) => pipeline.id === req.params.id,
        );
        if (!found) return null;
        if (typeof body.name === "string") found.name = body.name;
        if (body.stages !== undefined) found.stages = normalizeStages(body.stages);
        found.updatedAt = now();
        return found;
      });
      if (!saved) return res.status(404).json({ error: "Pipeline not found" });
      broadcast(
        "pipeline.definition_updated",
        saved,
        req.user.workspaceId || "default",
      );
      res.json(saved);
    },
  );

  app.delete(
    "/api/pipeline/definitions/:id",
    auth,
    requireRole("admin", "member"),
    async (req, res) => {
      const removed = await mutateDb((db) => {
        const list = Array.isArray(db.pipelineDefinitions)
          ? db.pipelineDefinitions
          : [];
        const index = list.findIndex(
          (pipeline) => pipeline.id === req.params.id,
        );
        if (index < 0) return null;
        const [deleted] = list.splice(index, 1);
        return deleted;
      });
      if (!removed) return res.status(404).json({ error: "Pipeline not found" });
      broadcast(
        "pipeline.definition_deleted",
        { id: req.params.id },
        req.user.workspaceId || "default",
      );
      res.json({ ok: true, id: req.params.id });
    },
  );

  // Deal fallback: when a deal is created without an explicit `pipelineId`,
  // attach the primary (first) pipeline. Registered ahead of the generic
  // `/api/:resource` handler so the value is on the body before it persists.
  app.use("/api/deals", auth, async (req, res, next) => {
    if (req.method !== "POST") return next();
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return next();
    }
    if (
      req.body.pipelineId === undefined ||
      req.body.pipelineId === null ||
      req.body.pipelineId === ""
    ) {
      try {
        const db = await readDb();
        const fallback = primaryPipelineId(db);
        if (fallback) req.body.pipelineId = fallback;
      } catch {
        // A missing/empty store must not block deal creation.
      }
    }
    return next();
  });
}
