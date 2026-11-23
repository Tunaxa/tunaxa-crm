import { z } from "zod";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { checkWriteFieldMask } from "./permissions.js";
import { createRateLimiter } from "../services/rateLimit.js";
import { cacheFlush } from "../services/cache.js";
import { broadcast } from "./sse.js";
import { moveDealsToStage, DealBatchMoveError } from "../services/dealPipeline.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const batchMoveLimiter = createRateLimiter({ windowMs: 60_000, max: 30, prefix: "deal-batch-move" });

function tenantOf(req) {
  return req.user?.workspaceId || req.user?.workspace_id || "default";
}

function hasForbiddenKeys(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenKeys);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || hasForbiddenKeys(value[key])) return true;
  }
  return false;
}

const batchMoveSchema = z.object({
  dealIds: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
  stage: z.string().trim().min(1).max(128),
  pipelineId: z.string().trim().min(1).max(128).optional(),
}).strict();

function parseBody(req, res) {
  if (hasForbiddenKeys(req.body)) {
    res.status(400).json({ error: "Invalid request" });
    return null;
  }
  const parsed = batchMoveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return null;
  }
  if (hasForbiddenKeys(parsed.data)) {
    res.status(400).json({ error: "Invalid request" });
    return null;
  }
  const dealIds = [];
  for (const id of parsed.data.dealIds) {
    if (!dealIds.includes(id)) dealIds.push(id);
  }
  return { ...parsed.data, dealIds };
}

function runBatchMove(mode) {
  return async (req, res) => {
    const body = parseBody(req, res);
    if (!body) return;
    try {
      const result = await moveDealsToStage({
        dealIds: body.dealIds,
        stage: body.stage,
        pipelineId: body.pipelineId,
        workspaceId: tenantOf(req),
        actor: req.user?.name || req.user?.email || null,
        mode,
      });
      cacheFlush("deals");
      broadcast("record.updated", { resource: "deals", item: result });
      return res.json(result);
    } catch (err) {
      if (err instanceof DealBatchMoveError) {
        return res.status(err.status).json({ error: err.status >= 500 ? "Internal server error" : err.message, code: err.code });
      }
      console.error("[deals] batch move failed:", err?.message || err);
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

export default function registerDealRoutes(app) {
  const guard = [auth, requireRole("admin", "member"), checkWriteFieldMask("deals")];
  app.post("/api/deals/batch-move", batchMoveLimiter, ...guard, runBatchMove("auto"));
  app.post("/api/deals/batch-stage", batchMoveLimiter, ...guard, runBatchMove("auto"));
}
