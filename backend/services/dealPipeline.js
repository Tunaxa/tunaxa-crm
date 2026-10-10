// Atomic batch stage transition for deals.
//
// POST /api/deals/batch-move turns several deals into one unit of work. The
// whole sequence - lock every deal, verify every id resolves inside the tenant,
// move them all, write a stage-change activity per deal - runs inside a single
// BEGIN/COMMIT on a dedicated pool client. There is no code path that commits
// any subset of it: a throw at any step issues ROLLBACK, which discards the
// UPDATEs along with the audit rows.
//
// The lock-and-verify dance at the top is what makes "move these N deals" safe:
//
//   1. `FOR UPDATE` takes a row lock on every deal in `id = ANY($1)`, so a
//      concurrent batch move or single-deal update of the same rows serialises
//      here instead of interleaving.
//   2. The lock query is tenant-scoped, so a deal that belongs to another
//      workspace simply does not come back. `rowCount < dealIds.length` is then
//      answered as 404 - the missing row and the cross-tenant row are
//      deliberately indistinguishable, so a response can never confirm that an
//      id exists somewhere else.
//   3. Because the UPDATE and the activities are in this transaction, the count
//      check result cannot race: the rows are locked, so nothing can disappear
//      between verify and write.

import { getPool } from "../db/pg.js";
import { mutateDb, readDb } from "../store.js";
import { now, id } from "../helpers.js";
import { PG_RESOURCES, pgToLegacy } from "../db/legacy-shape.js";
import { repoFor } from "../db/repositories/index.js";
import { DEFAULT_PIPELINE } from "../routes/pipeline.js";
import { isWonStage, triggerDealWonIntegrations } from "./integrations.js";

/** Error carrying the HTTP status the route should answer with. */
export class DealBatchMoveError extends Error {
  constructor(message, { status = 500, code = "BATCH_MOVE_FAILED" } = {}) {
    super(message);
    this.name = "DealBatchMoveError";
    this.status = status;
    this.code = code;
  }
}

/** The recognized stage names, compared case-insensitively. */
export const KNOWN_STAGES = DEFAULT_PIPELINE.map((stage) => String(stage.name).toLowerCase());

/**
 * Validate and normalize the request payload.
 *
 * dealIds must be a non-empty array of non-empty strings; duplicates are
 * collapsed so no deal is processed (or audited) twice. `stage` must be a
 * recognized pipeline stage - `New` and `new` are the same stage. `pipelineId`
 * is optional and passed through untouched.
 */
export function validateBatchMovePayload({ dealIds, stage, pipelineId } = {}) {
  if (!Array.isArray(dealIds) || dealIds.length === 0) {
    throw new DealBatchMoveError("dealIds must be a non-empty array", {
      status: 400,
      code: "INVALID_DEAL_IDS",
    });
  }

  const ids = [];
  for (const raw of dealIds) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      throw new DealBatchMoveError("dealIds must contain only non-empty strings", {
        status: 400,
        code: "INVALID_DEAL_IDS",
      });
    }
    if (!ids.includes(value)) ids.push(value);
  }
  if (ids.length === 0) {
    throw new DealBatchMoveError("dealIds must be a non-empty array", {
      status: 400,
      code: "INVALID_DEAL_IDS",
    });
  }

  const target = typeof stage === "string" ? stage.trim() : "";
  if (!target) {
    throw new DealBatchMoveError("stage is required", {
      status: 400,
      code: "INVALID_STAGE",
    });
  }
  if (!KNOWN_STAGES.includes(target.toLowerCase())) {
    throw new DealBatchMoveError(`Unknown stage: ${target}`, {
      status: 400,
      code: "UNKNOWN_STAGE",
    });
  }

  return {
    dealIds: ids,
    stage: target,
    pipelineId: typeof pipelineId === "string" && pipelineId.trim() ? pipelineId.trim() : null,
  };
}

// ROLLBACK without letting a secondary failure replace the original error. The
// only reasons ROLLBACK itself fails are that the transaction never started or
// the connection is gone - neither is actionable on top of the exception that
// got us here.
async function rollbackQuietly(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* no usable transaction left; the error that got us here is the real one */
  }
}

// A batch of moves shares one identity so the audit rows are traceable back to
// the request that produced them.
function batchIdFor(workspaceId) {
  return `batch_${Buffer.from(`${workspaceId}_${Date.now()}_${Math.random()}`).toString("hex").slice(0, 16)}`;
}

/**
 * Move `dealIds` to `stage` inside one PostgreSQL transaction.
 *
 * @throws {DealBatchMoveError} status 400 for a malformed request, 404 for a
 *   deal that is missing *or* owned by another tenant (deliberately
 *   indistinguishable).
 */
async function moveDealsToStagePg({ dealIds, stage, pipelineId, workspaceId, actor }) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    // Step 1: row-lock every deal, scoped to the tenant. The `default` tenant
    // also owns rows written before workspace_id existed, matching the
    // repositories.
    const locked = await client.query(
      `SELECT id, stage, workspace_id, title, contact, company, contact_id, company_id
         FROM deals
        WHERE id = ANY($1)
          AND (workspace_id = $2 OR ($2 = 'default' AND workspace_id IS NULL))
        FOR UPDATE`,
      [dealIds, workspaceId],
    );

    // Step 2: strict count verification. Fewer rows came back than were asked
    // for: one or more ids are missing outright or belong to another tenant.
    // Abort before a single deal is touched and answer 404 for both cases.
    if (locked.rowCount !== dealIds.length) {
      throw new DealBatchMoveError("One or more deals not found or unauthorized", {
        status: 404,
        code: "NOT_FOUND",
      });
    }

    // Step 3: atomic stage update for every verified row.
    const nowStamp = new Date();
    if (pipelineId) {
      await client.query(
        `UPDATE deals
            SET stage = $1, pipeline_id = $2, updated_at = $3
          WHERE id = ANY($4)
            AND (workspace_id = $5 OR ($5 = 'default' AND workspace_id IS NULL))`,
        [stage, pipelineId, nowStamp, dealIds, workspaceId],
      );
    } else {
      await client.query(
        `UPDATE deals
            SET stage = $1, updated_at = $2
          WHERE id = ANY($3)
            AND (workspace_id = $4 OR ($4 = 'default' AND workspace_id IS NULL))`,
        [stage, nowStamp, dealIds, workspaceId],
      );
    }

    // Step 4: a stage-change activity per deal, in the same transaction as the
    // UPDATE - a failed insert rolls the moves back with it.
    const batchId = batchIdFor(workspaceId);
    const moved = [];
    for (const deal of locked.rows) {
      const prevStage = deal.stage || null;
      const metadata = {
        pipeline: { action: "stage_change", from: prevStage, to: stage, pipelineId },
        batch: { batchId, count: dealIds.length, actor: actor || null },
        source: "batch-move",
        movedAt: nowStamp.toISOString(),
      };
      await client.query(
        `INSERT INTO activities
           (workspace_id, type, title, description, contact, company, contact_id,
            deal_id, record_id, entity_type, entity_id, metadata, custom_fields)
         VALUES
           ($1, 'stage_change', $2, $3, $4, $5, $6, $7, $7, 'deal', $7, $8::jsonb, '{}'::jsonb)
         RETURNING id`,
        [
          workspaceId,
          `Deal moved ${prevStage || ""} → ${stage}`,
          `Stage transition from ${prevStage || "none"} to ${stage} via batch move (${batchId}).`,
          deal.contact ?? null,
          deal.company ?? null,
          deal.contact_id ?? null,
          String(deal.id),
          JSON.stringify(metadata),
        ],
      );
      moved.push({ id: String(deal.id), prevStage });
    }

    await client.query("COMMIT");

    return {
      success: true,
      movedCount: moved.length,
      stage,
      dealIds,
      pipelineId,
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

/**
 * JSON-store equivalent. mutateDb() writes the file only after the mutator
 * resolves, so a throw anywhere above leaves the previous file in place - the
 * whole mutation is discarded, not just the failing step.
 */
async function moveDealsToStageJson({ dealIds, stage, pipelineId, workspaceId }) {
  const result = await mutateDb((db) => {
    const rows = db.deals || [];
    const byId = new Map(rows.map((row) => [String(row.id), row]));

    // Verify everything up front, before any row is touched: a missing id or a
    // row owned by another tenant aborts the whole callback (and therefore the
    // file write), leaving every deal untouched.
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
    }

    const stamp = now();
    const batchId = batchIdFor(workspaceId);
    const moved = [];
    for (const dealId of dealIds) {
      const row = byId.get(String(dealId));
      const prevStage = row.stage ?? null;
      row.stage = stage;
      if (pipelineId) row.pipelineId = pipelineId;
      row.prevStage = prevStage;
      row.stageChangedAt = stamp;
      row.updatedAt = stamp;
      moved.push({ id: row.id, prevStage });

      db.activities = db.activities || [];
      db.activities.unshift({
        id: id("activity"),
        title: `Deal moved ${prevStage || ""} → ${stage}`,
        type: "stage_change",
        contact: row.company || row.title || "",
        notes: `Stage transition from ${prevStage || "none"} to ${stage} via batch move (${batchId}).`,
        date: stamp.slice(0, 10),
        dealId: row.id,
        createdAt: stamp,
        updatedAt: stamp,
      });
    }

    return { moved };
  });

  return {
    success: true,
    movedCount: result.moved.length,
    stage,
    dealIds,
    pipelineId,
    batchId: null,
    moved: result.moved,
  };
}

/**
 * Fire deal.won webhooks for the rows a batch move just promoted into a won
 * stage. Runs after the transaction has committed, per deal, and every step is
 * wrapped so a webhook failure - or even a re-read failure - can never fail the
 * move that triggered it.
 */
async function notifyWonBatch({ result, workspaceId, usePostgres }) {
  if (!isWonStage(result.stage)) return;
  const candidates = result.moved.filter(({ prevStage }) => !isWonStage(prevStage));
  if (candidates.length === 0) return;

  const fire = async ({ prevStage, deal }) => {
    if (!deal) return;
    await triggerDealWonIntegrations({
      deal,
      previousStage: prevStage,
      workspaceId,
    });
  };

  if (usePostgres) {
    const repo = repoFor("deals");
    await Promise.allSettled(
      candidates.map(({ id: dealId, prevStage }) =>
        repo
          .findById(dealId, workspaceId)
          .then((row) => (row ? pgToLegacy(row, "deals") : null))
          .then((deal) => fire({ prevStage, deal })),
      ),
    );
  } else {
    const db = await readDb();
    await Promise.allSettled(
      candidates.map(({ id: dealId, prevStage }) => {
        const row = (db.deals || []).find((d) => String(d.id) === String(dealId));
        return fire({ prevStage, deal: row || null });
      }),
    );
  }
}

/**
 * Atomically move `dealIds` to `stage`.
 *
 * `mode: "auto"` uses Postgres (deals is a PG resource) and the JSON store
 * otherwise. It deliberately does *not* fall back to the JSON store when
 * Postgres throws: a move that only lands in the JSON file while the database
 * keeps the old stage would be exactly the split-brain this endpoint exists to
 * prevent.
 *
 * @throws {DealBatchMoveError} with status 400 (malformed request or unknown
 *   stage) or 404 (a deal missing, or belonging to another tenant).
 */
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
  const result = usePostgres ? await moveDealsToStagePg(args) : await moveDealsToStageJson(args);
  await notifyWonBatch({ result, workspaceId: workspaceId ?? "default", usePostgres });
  return result;
}