// Deal-specific route additions that the generic /api/:resource router cannot
// express: POST /api/deals/batch-move (and its /api/deals/batch-stage alias)
// moves many deals to one pipeline stage atomically.
//
// Registered ahead of routes/resources.js so the literal `batch-move` /
// `batch-stage` segments win over the generic `/api/:resource/:id` handler.
// The write-field-mask check runs against the request body, so a
// masked `stage` (or a masked custom field sneaked into the body) answers 403
// before the transaction starts.

import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { checkWriteFieldMask } from "./permissions.js";
import { moveDealsToStage, DealBatchMoveError } from "../services/dealPipeline.js";
import { cacheFlush } from "../services/cache.js";
import { broadcast } from "./sse.js";

function tenantOf(req) {
  return req.user?.workspaceId || req.user?.workspace_id || "default";
}

function runBatchMove(mode) {
  return async (req, res, next) => {
    try {
      const result = await moveDealsToStage({
        dealIds: req.body?.dealIds,
        stage: req.body?.stage,
        pipelineId: req.body?.pipelineId,
        workspaceId: tenantOf(req),
        actor: req.user?.name || req.user?.email || null,
        mode,
      });
      cacheFlush("deals");
      broadcast("record.updated", { resource: "deals", item: result });
      return res.json(result);
    } catch (err) {
      // DealBatchMoveError carries the status its failure means: 400 for a
      // malformed request or unknown stage, 404 for a deal that is missing *
      // or* owned by another tenant (deliberately indistinguishable). Anything
      // else is a genuine fault and goes to the error handler.
      if (err instanceof DealBatchMoveError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      return next(err);
    }
  };
}

export default function registerDealRoutes(app) {
  const guard = [auth, requireRole("admin", "member"), checkWriteFieldMask("deals")];

  app.post("/api/deals/batch-move", ...guard, runBatchMove("auto"));
  app.post("/api/deals/batch-stage", ...guard, runBatchMove("auto"));
}