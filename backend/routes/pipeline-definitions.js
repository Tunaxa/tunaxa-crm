import { z } from "zod";
import { readDb, mutateDb } from "../store.js";
import { query } from "../db/pg.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { validate } from "../services/validate.js";
import { id, now } from "../helpers.js";
import { broadcast } from "./sse.js";

// ---------------------------------------------------------------------------
// Tenant resolution
// ---------------------------------------------------------------------------

// Mirrors resources.js tenantOf(): a user without an explicit workspace still
// resolves to the `default` tenant, which is the column default in the schema.
// An undefined value here would silently disable scoping, so never return it.
const tenantOf = (req) =>
  req.user?.workspaceId || req.user?.workspace_id || "default";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const StageSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1, "Stage key is required")
      .max(64, "Stage key is too long")
      .regex(/^[a-z0-9][a-z0-9_-]*$/i, "Stage key must be a slug")
      .refine((k) => !FORBIDDEN_KEYS.has(k.toLowerCase()), "Reserved stage key"),
    label: z.string().trim().min(1, "Stage label is required").max(100),
    probability: z
      .number()
      .refine(Number.isFinite, "Probability must be finite")
      .int("Probability must be an integer")
      .min(0, "Probability must be at least 0")
      .max(100, "Probability must be at most 100"),
    order: z.number().int().min(0).max(1000).default(0),
  })
  .strict();

const StagesSchema = z
  .array(StageSchema)
  .min(1, "At least one stage is required")
  .max(20, "At most 20 stages are allowed")
  .superRefine((stages, ctx) => {
    const seen = new Set();
    stages.forEach((stage, index) => {
      const key = stage.key.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: "Duplicate stage key",
          path: [index, "key"],
        });
      }
      seen.add(key);
    });
  });

export const CreatePipelineSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    entityType: z.enum(["deal", "lead"]).default("deal"),
    isDefault: z.boolean().default(false),
    stages: StagesSchema,
  })
  .strict();

export const UpdatePipelineSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100).optional(),
    entityType: z.enum(["deal", "lead"]).optional(),
    isDefault: z.boolean().optional(),
    stages: StagesSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field is required",
  });

// ---------------------------------------------------------------------------
// Storage: Postgres with a JSON-store fallback
// ---------------------------------------------------------------------------

const COLUMNS =
  "id, workspace_id, name, entity_type, is_default, stages, created_by, created_at, updated_at";
const FALLBACK_CODES = new Set([
  "42P01", // relation does not exist (migration not applied)
  "ECONNREFUSED",
  "ETIMEDOUT",
  "3D000", // database does not exist
  "28P01", // bad credentials
]);

let pgAvailable = null;

async function pgReady() {
  if (pgAvailable === null) {
    try {
      await query("SELECT 1 FROM pipeline_definitions LIMIT 1");
      pgAvailable = true;
    } catch (error) {
      if (FALLBACK_CODES.has(error?.code)) pgAvailable = false;
      else throw error;
    }
  }
  return pgAvailable;
}

function fromRow(row) {
  let stages = [];
  try {
    const raw = row.stages;
    stages = Array.isArray(raw) ? raw : JSON.parse(String(raw || "[]"));
  } catch {
    stages = [];
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    entityType: row.entity_type || "deal",
    isDefault: Boolean(row.is_default),
    stages: Array.isArray(stages) ? stages : [],
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jsonList(list, tenant) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && p.workspaceId === tenant)
    .map((p) => ({
      id: p.id,
      workspaceId: p.workspaceId,
      name: p.name,
      entityType: p.entityType || "deal",
      isDefault: Boolean(p.isDefault),
      stages: Array.isArray(p.stages) ? p.stages : [],
      createdBy: p.createdBy ?? null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
}

async function listDefinitions(tenant) {
  if (await pgReady()) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM pipeline_definitions WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`,
      [tenant],
    );
    return rows.map(fromRow);
  }
  const db = await readDb();
  return jsonList(db.pipelineDefinitions, tenant);
}

async function findDefinition(tenant, definitionId) {
  if (await pgReady()) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM pipeline_definitions WHERE workspace_id = $1 AND id = $2`,
      [tenant, definitionId],
    );
    return rows.length ? fromRow(rows[0]) : null;
  }
  const db = await readDb();
  return jsonList(db.pipelineDefinitions, tenant).find(
    (p) => p.id === definitionId,
  ) || null;
}

async function createDefinition(tenant, req, value) {
  const ts = now();
  const record = {
    id: id("pipeline"),
    workspaceId: tenant,
    name: value.name,
    entityType: value.entityType,
    isDefault: Boolean(value.isDefault),
    stages: value.stages,
    createdBy: req.user?.id || null,
    createdAt: ts,
    updatedAt: ts,
  };

  if (await pgReady()) {
    if (record.isDefault) {
      await query(
        "UPDATE pipeline_definitions SET is_default = FALSE WHERE workspace_id = $1 AND entity_type = $2",
        [tenant, record.entityType],
      );
    }
    await query(
      `INSERT INTO pipeline_definitions (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.id,
        record.workspaceId,
        record.name,
        record.entityType,
        record.isDefault,
        JSON.stringify(record.stages),
        record.createdBy,
        record.createdAt,
        record.updatedAt,
      ],
    );
    return record;
  }

  await mutateDb((db) => {
    if (!Array.isArray(db.pipelineDefinitions)) db.pipelineDefinitions = [];
    if (record.isDefault) {
      for (const p of db.pipelineDefinitions) {
        if (p.workspaceId === tenant && p.entityType === record.entityType) {
          p.isDefault = false;
        }
      }
    }
    db.pipelineDefinitions.push(record);
  });
  return record;
}

async function updateDefinition(tenant, definitionId, patch) {
  if (await pgReady()) {
    const existing = await findDefinition(tenant, definitionId);
    if (!existing) return null;
    const next = {
      ...existing,
      ...patch,
      id: existing.id,
      workspaceId: tenant,
      updatedAt: now(),
    };
    if (next.isDefault) {
      await query(
        "UPDATE pipeline_definitions SET is_default = FALSE WHERE workspace_id = $1 AND entity_type = $2 AND id <> $3",
        [tenant, next.entityType, definitionId],
      );
    }
    const { rows } = await query(
      `UPDATE pipeline_definitions SET name = $3, entity_type = $4, is_default = $5, stages = $6, updated_at = $7 WHERE workspace_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
      [
        tenant,
        definitionId,
        next.name,
        next.entityType,
        next.isDefault,
        JSON.stringify(next.stages),
        next.updatedAt,
      ],
    );
    return rows.length ? fromRow(rows[0]) : null;
  }

  return mutateDb((db) => {
    const list = Array.isArray(db.pipelineDefinitions)
      ? db.pipelineDefinitions
      : [];
    const found = list.find(
      (p) => p && p.id === definitionId && p.workspaceId === tenant,
    );
    if (!found) return null;
    const entityType = patch.entityType || found.entityType || "deal";
    if (patch.isDefault) {
      for (const p of list) {
        if (
          p &&
          p.id !== definitionId &&
          p.workspaceId === tenant &&
          (p.entityType || "deal") === entityType
        ) {
          p.isDefault = false;
        }
      }
    }
    // patch is Zod-stripped, so it only carries known scalar/array keys.
    Object.assign(found, patch, {
      id: found.id,
      workspaceId: tenant,
      entityType,
      updatedAt: now(),
    });
    return { ...found };
  });
}

async function deleteDefinition(tenant, definitionId) {
  if (await pgReady()) {
    const { rowCount } = await query(
      "DELETE FROM pipeline_definitions WHERE workspace_id = $1 AND id = $2",
      [tenant, definitionId],
    );
    return rowCount > 0;
  }
  return mutateDb((db) => {
    const list = Array.isArray(db.pipelineDefinitions)
      ? db.pipelineDefinitions
      : [];
    const index = list.findIndex(
      (p) => p && p.id === definitionId && p.workspaceId === tenant,
    );
    if (index < 0) return false;
    list.splice(index, 1);
    db.pipelineDefinitions = list;
    return true;
  });
}

async function countDealsUsing(tenant, definitionId) {
  let count = 0;
  // Deals may live in Postgres or in the JSON store independently of where the
  // definitions live (e.g. migration 013 pending but the deals table present),
  // so probe both stores instead of gating this on pgReady().
  try {
    const { rows } = await query(
      "SELECT COUNT(*)::int AS n FROM deals WHERE workspace_id = $1 AND pipeline_id = $2",
      [tenant, definitionId],
    );
    count += Number(rows[0]?.n || 0);
  } catch (error) {
    // A missing table or an unreachable server simply means this store has no
    // deals to count; the JSON store is checked below.
    if (!FALLBACK_CODES.has(error?.code)) throw error;
  }
  const db = await readDb();
  count += (Array.isArray(db.deals) ? db.deals : []).filter(
    (d) =>
      d &&
      (d.pipelineId === definitionId || d.pipeline_id === definitionId) &&
      (d.workspaceId === tenant || d.workspace_id === tenant || !d.workspaceId),
  ).length;
  return count;
}

// ---------------------------------------------------------------------------
// Deal validation helper (mounted on deal write routes in resources.js)
// ---------------------------------------------------------------------------

/**
 * Validate/default `pipelineId` on deal writes. Runs after the shared field
 * mask and body validation, so it can never bypass either. Every lookup and
 * every default is scoped to the requesting tenant.
 */
export async function validateDealPipeline(req, res, next) {
  try {
    if (req.params.resource && req.params.resource !== "deals") return next();

    const tenant = tenantOf(req);
    const raw = req.body;
    // Batch PATCH carries its delta under `data`, not at the top level.
    const body =
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      Array.isArray(raw.ids) &&
      raw.data
        ? raw.data
        : raw;
    const items = Array.isArray(body) ? body : [body];
    const isCreate = req.method === "POST";

    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const supplied = item.pipelineId;

      if (supplied === undefined || supplied === null || supplied === "") {
        // Only creation defaults the pipeline; a PATCH/PUT that omits the
        // field must not silently reassign an existing deal.
        if (!isCreate) continue;
        const defs = await listDefinitions(tenant);
        const fallback =
          defs.find((d) => d.isDefault && d.entityType === "deal") ||
          defs.find((d) => d.entityType === "deal") ||
          defs[0];
        if (fallback) item.pipelineId = fallback.id;
        continue;
      }

      if (typeof supplied !== "string") {
        return res.status(400).json({ error: "pipelineId must be a string" });
      }
      const match = await findDefinition(tenant, supplied);
      if (!match) {
        // Covers both an unknown id and a definition owned by another tenant.
        return res.status(404).json({ error: "Pipeline not found" });
      }
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default function registerPipelineDefinitionRoutes(app) {
  app.get("/api/pipeline-definitions", auth, async (req, res, next) => {
    try {
      res.json(await listDefinitions(tenantOf(req)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/pipeline-definitions/:id", auth, async (req, res, next) => {
    try {
      const found = await findDefinition(tenantOf(req), req.params.id);
      if (!found) return res.status(404).json({ error: "Pipeline not found" });
      return res.json(found);
    } catch (error) {
      return next(error);
    }
  });

  app.post(
    "/api/pipeline-definitions",
    auth,
    requireRole("admin", "owner"),
    validate(CreatePipelineSchema),
    async (req, res, next) => {
      try {
        const tenant = tenantOf(req);
        const saved = await createDefinition(tenant, req, req.body);
        broadcast(
          "pipeline.definition_created",
          saved,
          { workspaceId: tenant },
        );
        return res.status(201).json(saved);
      } catch (error) {
        return next(error);
      }
    },
  );

  app.put(
    "/api/pipeline-definitions/:id",
    auth,
    requireRole("admin", "owner"),
    validate(UpdatePipelineSchema),
    async (req, res, next) => {
      try {
        const tenant = tenantOf(req);
        const saved = await updateDefinition(
          tenant,
          req.params.id,
          req.body,
        );
        if (!saved) {
          return res.status(404).json({ error: "Pipeline not found" });
        }
        broadcast(
          "pipeline.definition_updated",
          saved,
          { workspaceId: tenant },
        );
        return res.json(saved);
      } catch (error) {
        return next(error);
      }
    },
  );

  app.delete(
    "/api/pipeline-definitions/:id",
    auth,
    requireRole("admin", "owner"),
    async (req, res, next) => {
      try {
        const tenant = tenantOf(req);
        const existing = await findDefinition(tenant, req.params.id);
        if (!existing) {
          return res.status(404).json({ error: "Pipeline not found" });
        }

        const siblings = await listDefinitions(tenant);
        const sameType = siblings.filter(
          (p) => (p.entityType || "deal") === existing.entityType,
        );
        if (sameType.length <= 1) {
          return res.status(409).json({
            error: "Cannot delete the last pipeline definition",
          });
        }
        if (existing.isDefault) {
          return res.status(409).json({
            error:
              "Cannot delete the default pipeline definition; set another as default first",
          });
        }
        const inUse = await countDealsUsing(tenant, req.params.id);
        if (inUse > 0) {
          return res.status(409).json({
            error: `Cannot delete pipeline definition: ${inUse} deal(s) still reference it`,
          });
        }

        await deleteDefinition(tenant, req.params.id);
        broadcast(
          "pipeline.definition_deleted",
          { id: req.params.id },
          { workspaceId: tenant },
        );
        return res.json({ ok: true, id: req.params.id });
      } catch (error) {
        return next(error);
      }
    },
  );
}
