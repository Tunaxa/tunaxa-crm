import { getPool } from "../db/pg.js";
import { mutateDb, readDb } from "../store.js";
import { now, id } from "../helpers.js";
import { PG_RESOURCES } from "../db/legacy-shape.js";
import { DEFAULT_PIPELINE } from "../routes/pipeline.js";
import { query } from "../db/pg.js";

export class DealBatchMoveError extends Error {
  constructor(message, { status = 500, code = "BATCH_MOVE_FAILED" } = {}) {
    super(message);
    this.name = "DealBatchMoveError";
    this.status = status;
    this.code = code;
  }
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hasForbiddenKeys(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenKeys);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || hasForbiddenKeys(value[key])) return true;
  }
  return false;
}

export function assertNoForbiddenKeys(value) {
  if (hasForbiddenKeys(value)) {
    throw new DealBatchMoveError("Invalid request", {
      status: 400,
      code: "INVALID_REQUEST",
    });
  }
}

function normalizeDealIds(dealIds) {
  if (!Array.isArray(dealIds) || dealIds.length < 1 || dealIds.length > 100) {
    throw new DealBatchMoveError("dealIds must contain 1 to 100 items", {
      status: 400,
      code: "INVALID_DEAL_IDS",
    });
  }
  const ids = [];
  for (const raw of dealIds) {
    if (typeof raw !== "string") {
      throw new DealBatchMoveError("dealIds must contain only strings", {
        status: 400,
        code: "INVALID_DEAL_IDS",
      });
    }
    const value = raw.trim();
    if (!value) {
      throw new DealBatchMoveError("dealIds must contain non-empty strings", {
        status: 400,
        code: "INVALID_DEAL_IDS",
      });
    }
    if (!ids.includes(value)) ids.push(value);
  }
  if (!ids.length) {
    throw new DealBatchMoveError("dealIds must contain 1 to 100 items", {
      status: 400,
      code: "INVALID_DEAL_IDS",
    });
  }
  return ids;
}

export function validateBatchMovePayload(payload = {}) {
  assertNoForbiddenKeys(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DealBatchMoveError("Invalid request body", {
      status: 400,
      code: "INVALID_REQUEST",
    });
  }
  const allowed = new Set(["dealIds", "stage", "pipelineId"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new DealBatchMoveError("Invalid request", {
        status: 400,
        code: "INVALID_REQUEST",
      });
    }
  }
  const dealIds = normalizeDealIds(payload.dealIds);
  const stage = typeof payload.stage === "string" ? payload.stage.trim() : "";
  if (!stage) {
    throw new DealBatchMoveError("stage is required", {
      status: 400,
      code: "INVALID_STAGE",
    });
  }
  let pipelineId = null;
  if (payload.pipelineId !== undefined && payload.pipelineId !== null && payload.pipelineId !== "") {
    if (typeof payload.pipelineId !== "string") {
      throw new DealBatchMoveError("pipelineId must be a string", {
        status: 400,
        code: "INVALID_PIPELINE_ID",
      });
    }
    pipelineId = payload.pipelineId.trim();
    if (!pipelineId) {
      throw new DealBatchMoveError("pipelineId must be a non-empty string", {
        status: 400,
        code: "INVALID_PIPELINE_ID",
      });
    }
  }
  return { dealIds, stage, pipelineId };
}

function parseStages(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function listPipelineDefinitionsPg(workspaceId) {
  const result = await query(
    `SELECT id, workspace_id, name, entity_type, is_default, stages
     FROM pipeline_definitions
     WHERE workspace_id = $1
     ORDER BY created_at ASC, id ASC`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    entityType: row.entity_type || "deal",
    isDefault: Boolean(row.is_default),
    stages: parseStages(row.stages),
  }));
}

async function listPipelineDefinitions(workspaceId) {
  try {
    return await listPipelineDefinitionsPg(workspaceId);
  } catch (error) {
    if (!["42P01", "ECONNREFUSED", "ETIMEDOUT", "3D000", "28P01"].includes(error?.code)) {
      throw error;
    }
  }
  const db = await readDb();
  return (Array.isArray(db.pipelineDefinitions) ? db.pipelineDefinitions : [])
    .filter((p) => p && (p.workspaceId === workspaceId || p.workspace_id === workspaceId))
    .map((p) => ({
      id: p.id,
      workspaceId: p.workspaceId || p.workspace_id,
      name: p.name,
      entityType: p.entityType || p.entity_type || "deal",
      isDefault: Boolean(p.isDefault ?? p.is_default),
      stages: Array.isArray(p.stages) ? p.stages : parseStages(p.stages),
    }));
}

function normalizeStageName(stage) {
  return String(stage || "").trim().toLowerCase();
}

function resolveStage(definition, stage) {
  const wanted = normalizeStageName(stage);
  const stages = Array.isArray(definition?.stages) ? definition.stages : [];
  return stages.find((item) => {
    const key = normalizeStageName(item?.key);
    const label = normalizeStageName(item?.label);
    const name = normalizeStageName(item?.name);
    return wanted && (wanted === key || wanted === label || wanted === name);
  }) || null;
}

function defaultDealPipeline(definitions) {
  const dealDefs = definitions.filter((d) => (d.entityType || "deal") === "deal");
  return dealDefs.find((d) => d.isDefault) || dealDefs[0] || definitions[0] || null;
}

function builtinDefaultPipeline() {
  return {
    id: null,
    workspaceId: "default",
    name: "Default",
    entityType: "deal",
    isDefault: true,
    stages: DEFAULT_PIPELINE.map((s, index) => ({
      key: String(s.name).toLowerCase(),
      label: s.name,
      name: s.name,
      probability: s.probability,
      order: index,
    })),
  };
}

async function resolvePipelineForMove({ workspaceId, pipelineId, deals, stage }) {
  const definitions = await listPipelineDefinitions(workspaceId);
  if (pipelineId) {
    const selected = definitions.find((d) => d.id === pipelineId);
    if (!selected) {
      throw new DealBatchMoveError("Pipeline not found", {
        status: 404,
        code: "PIPELINE_NOT_FOUND",
      });
    }
    const stageDef = resolveStage(selected, stage);
    if (!stageDef) {
      throw new DealBatchMoveError("Invalid stage for pipeline", {
        status: 400,
        code: "INVALID_STAGE",
      });
    }
    return { selected, stageDef, definitions };
  }

  const effectiveDefinitions = definitions.length ? definitions : [builtinDefaultPipeline()];
  const fallback = defaultDealPipeline(effectiveDefinitions);
  const resolutions = new Map();
  for (const deal of deals) {
    const dealPipelineId = deal.pipeline_id || deal.pipelineId || fallback?.id || null;
    const definition = effectiveDefinitions.find((d) => d.id && d.id === dealPipelineId) || fallback;
    if (!definition) {
      throw new DealBatchMoveError("Invalid stage for pipeline", {
        status: 400,
        code: "INVALID_STAGE",
      });
    }
    const stageDef = resolveStage(definition, stage);
    if (!stageDef) {
      throw new DealBatchMoveError("Invalid stage for pipeline", {
        status: 400,
        code: "INVALID_STAGE",
      });
    }
    resolutions.set(String(deal.id), { definition, stageDef });
  }
  return { selected: null, stageDef: null, definitions: effectiveDefinitions, resolutions };
}

async function rollbackQuietly(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    void 0;
  }
}

function batchIdFor(workspaceId) {
  return `batch_${Buffer.from(`${workspaceId}_${Date.now()}_${Math.random()}`).toString("hex").slice(0, 16)}`;
}

function stageLabel(stageDef, fallback) {
  return stageDef?.label || stageDef?.key || fallback;
}

function isWonStage(stageDef, stage) {
  const key = normalizeStageName(stageDef?.key || stage);
  const label = normalizeStageName(stageDef?.label || stage);
  return key === "won" || label === "won" || Number(stageDef?.probability) === 100 && (key.includes("won") || label.includes("won"));
}

async function moveDealsToStagePg({ dealIds, stage, pipelineId, workspaceId, actor }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id, stage, workspace_id, title, contact, company, contact_id, company_id, pipeline_id, custom_fields
         FROM deals
        WHERE id = ANY($1)
          AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL))
        FOR UPDATE`,
      [dealIds, workspaceId],
    );
    if (locked.rowCount !== dealIds.length) {
      throw new DealBatchMoveError("One or more deals not found or unauthorized", {
        status: 404,
        code: "NOT_FOUND",
      });
    }

    const { selected, stageDef, resolutions } = await resolvePipelineForMove({
      workspaceId,
      pipelineId,
      deals: locked.rows,
      stage,
    });

    const nowStamp = new Date();
    const batchId = batchIdFor(workspaceId);
    const moved = [];
    for (const deal of locked.rows) {
      const resolution = selected ? { definition: selected, stageDef } : resolutions.get(String(deal.id));
      const targetPipelineId = selected ? selected.id : (pipelineId || resolution.definition.id || deal.pipeline_id || null);
      const resolvedStage = resolution.stageDef;
      const targetLabel = stageLabel(resolvedStage, stage);
      const prevStage = deal.stage || null;
      const customFields = deal.custom_fields && typeof deal.custom_fields === "object" ? deal.custom_fields : {};
      const nextCustomFields = {
        ...customFields,
        prevStage,
        stageChangedAt: nowStamp.toISOString(),
        probability: resolvedStage?.probability,
      };
      await client.query(
        `UPDATE deals
            SET stage = $1, pipeline_id = $2, updated_at = $3, custom_fields = $4::jsonb
          WHERE id = $5
            AND (workspace_id = $6 OR ($6 = 'default' AND workspace_id IS NULL))`,
        [targetLabel, targetPipelineId, nowStamp, JSON.stringify(nextCustomFields), deal.id, workspaceId],
      );

      if (isWonStage(resolvedStage, targetLabel) && deal.contact_id) {
        await client.query(
          `UPDATE contacts
              SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || '{"lifecycleStage":"Customer"}'::jsonb,
                  updated_at = $1
            WHERE id = $2
              AND (workspace_id = $3 OR ($3 = 'default' AND workspace_id IS NULL))`,
          [nowStamp, deal.contact_id, workspaceId],
        );
      }

      const metadata = {
        pipeline: { action: "stage_change", from: prevStage, to: targetLabel, pipelineId: targetPipelineId },
        batch: { batchId, count: dealIds.length, actor: actor || null },
        source: "batch-move",
        movedAt: nowStamp.toISOString(),
      };
      await client.query(
        `INSERT INTO activities
           (workspace_id, type, title, description, contact, company, contact_id,
            deal_id, record_id, entity_type, entity_id, metadata, custom_fields)
         VALUES
           ($1, 'stage_change', $2, $3, $4, $5, $6, $7, $7, 'deal', $7, $8::jsonb, '{}'::jsonb)`,
        [
          workspaceId,
          `Deal moved ${prevStage || ""} → ${targetLabel}`,
          `Stage transition from ${prevStage || "none"} to ${targetLabel} via batch move (${batchId}).`,
          deal.contact ?? null,
          deal.company ?? null,
          deal.contact_id ?? null,
          String(deal.id),
          JSON.stringify(metadata),
        ],
      );
      moved.push({ id: String(deal.id), prevStage, stage: targetLabel, pipelineId: targetPipelineId });
    }

    await client.query("COMMIT");
    return {
      success: true,
      movedCount: moved.length,
      stage: selected ? stageLabel(stageDef, stage) : stage,
      dealIds,
      pipelineId: selected ? selected.id : pipelineId,
      batchId,
      moved,
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function moveDealsToStageJson({ dealIds, stage, pipelineId, workspaceId, actor }) {
  const definitions = await listPipelineDefinitions(workspaceId);
  const result = await mutateDb((db) => {
    const rows = Array.isArray(db.deals) ? db.deals : [];
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const locked = [];
    for (const dealId of dealIds) {
      const row = byId.get(String(dealId));
      if (!row) {
        throw new DealBatchMoveError("One or more deals not found or unauthorized", {
          status: 404,
          code: "NOT_FOUND",
        });
      }
      const owner = row.workspaceId ?? row.workspace_id;
      if (owner != null && String(owner) !== String(workspaceId)) {
        throw new DealBatchMoveError("One or more deals not found or unauthorized", {
          status: 404,
          code: "NOT_FOUND",
        });
      }
      locked.push(row);
    }

    let selected = null;
    let selectedStage = null;
    let resolutions = new Map();
    if (pipelineId) {
      selected = definitions.find((d) => d.id === pipelineId);
      if (!selected) {
        throw new DealBatchMoveError("Pipeline not found", { status: 404, code: "PIPELINE_NOT_FOUND" });
      }
      selectedStage = resolveStage(selected, stage);
      if (!selectedStage) {
        throw new DealBatchMoveError("Invalid stage for pipeline", { status: 400, code: "INVALID_STAGE" });
      }
    } else {
      const fallback = defaultDealPipeline(definitions);
      if (!fallback) {
        throw new DealBatchMoveError("Invalid stage for pipeline", { status: 400, code: "INVALID_STAGE" });
      }
      for (const deal of locked) {
        const dealPipelineId = deal.pipelineId || deal.pipeline_id || fallback.id;
        const definition = definitions.find((d) => d.id === dealPipelineId) || fallback;
        const stageDef = resolveStage(definition, stage);
        if (!stageDef) {
          throw new DealBatchMoveError("Invalid stage for pipeline", { status: 400, code: "INVALID_STAGE" });
        }
        resolutions.set(String(deal.id), { definition, stageDef });
      }
    }

    const stamp = now();
    const batchId = batchIdFor(workspaceId);
    const moved = [];
    db.activities = Array.isArray(db.activities) ? db.activities : [];
    db.contacts = Array.isArray(db.contacts) ? db.contacts : [];
    for (const row of locked) {
      const resolution = selected ? { definition: selected, stageDef: selectedStage } : resolutions.get(String(row.id));
      const targetLabel = stageLabel(resolution.stageDef, stage);
      const targetPipelineId = selected ? selected.id : (resolution.definition.id || row.pipelineId || row.pipeline_id || null);
      const prevStage = row.stage ?? null;
      row.stage = targetLabel;
      row.pipelineId = targetPipelineId;
      row.pipeline_id = targetPipelineId;
      row.prevStage = prevStage;
      row.probability = resolution.stageDef?.probability;
      row.stageChangedAt = stamp;
      row.updatedAt = stamp;
      row.customFields = {
        ...(row.customFields && typeof row.customFields === "object" ? row.customFields : {}),
        prevStage,
        stageChangedAt: stamp,
        probability: resolution.stageDef?.probability,
      };

      if (isWonStage(resolution.stageDef, targetLabel) && row.company) {
        for (const contact of db.contacts) {
          const owner = contact.workspaceId ?? contact.workspace_id;
          if (owner != null && String(owner) !== String(workspaceId)) continue;
          if (contact.company === row.company) {
            contact.lifecycleStage = "Customer";
            contact.updatedAt = stamp;
          }
        }
      }

      db.activities.unshift({
        id: id("activity"),
        workspaceId,
        workspace_id: workspaceId,
        title: `Deal moved ${prevStage || ""} → ${targetLabel}`,
        type: "stage_change",
        contact: row.company || row.title || "",
        notes: `Stage transition from ${prevStage || "none"} to ${targetLabel} via batch move (${batchId}).`,
        date: stamp.slice(0, 10),
        dealId: row.id,
        metadata: {
          pipeline: { action: "stage_change", from: prevStage, to: targetLabel, pipelineId: targetPipelineId },
          batch: { batchId, count: dealIds.length, actor: actor || null },
          source: "batch-move",
          movedAt: stamp,
        },
        createdAt: stamp,
        updatedAt: stamp,
      });
      moved.push({ id: String(row.id), prevStage, stage: targetLabel, pipelineId: targetPipelineId });
    }
    return { moved, batchId, stageLabel: selected ? stageLabel(selectedStage, stage) : stage, pipelineId: selected ? selected.id : pipelineId };
  });

  return {
    success: true,
    movedCount: result.moved.length,
    stage: result.stageLabel,
    dealIds,
    pipelineId: result.pipelineId,
    batchId: result.batchId,
    moved: result.moved,
  };
}

export async function moveDealsToStage({
  dealIds,
  stage,
  pipelineId,
  workspaceId = "default",
  actor = null,
  mode = "auto",
} = {}) {
  const normalized = validateBatchMovePayload({ dealIds, stage, pipelineId });
  const args = {
    dealIds: normalized.dealIds,
    stage: normalized.stage,
    pipelineId: normalized.pipelineId,
    workspaceId: workspaceId ?? "default",
    actor,
  };
  const usePostgres = mode === "pg" || (mode === "auto" && PG_RESOURCES.has("deals"));
  return usePostgres ? moveDealsToStagePg(args) : moveDealsToStageJson(args);
}




