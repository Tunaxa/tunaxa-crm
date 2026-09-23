import { readDb, mutateDb } from "../store.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { id, now } from "../helpers.js";
import { broadcast } from "./sse.js";

export const DEFAULT_PIPELINE = [
  { name: "New", probability: 10, required: [] },
  { name: "Qualified", probability: 25, required: ["company"] },
  { name: "Proposal", probability: 50, required: ["value", "closeDate"] },
  { name: "Negotiation", probability: 75, required: ["value"] },
  { name: "Won", probability: 100, required: ["value"] },
  { name: "Lost", probability: 0, required: [] },
];

function pipelineProbabilityFor(name, index) {
  const map = {
    New: 10,
    Qualified: 25,
    Proposal: 50,
    Negotiation: 75,
    Won: 100,
    Lost: 0,
  };
  if (map[name] !== undefined) return map[name];
  return Math.min(index * 10, 80);
}

export default function registerPipelineRoutes(app) {
  app.get("/api/pipeline", auth, async (req, res) => {
    const db = await readDb();
    const stages =
      db.settings?.pipelineStages && Array.isArray(db.settings.pipelineStages)
        ? db.settings.pipelineStages.map((name, i) => ({
            name,
            probability: pipelineProbabilityFor(name, i),
            required: (db.stageGates || {})[name] || [],
          }))
        : DEFAULT_PIPELINE;
    const deals = (db.deals || []).filter((d) => !["Lost"].includes(d.stage));
    const withStage = stages.map((stage) => {
      const inStage = deals.filter((d) => d.stage === stage.name);
      return {
        ...stage,
        deals: inStage,
        value: inStage.reduce((s, d) => s + Number(d.value || 0), 0),
      };
    });
    res.json({
      stages: withStage,
      totalValue: withStage.reduce((s, st) => s + st.value, 0),
    });
  });

  // Configure stage gating (mandatory fields per stage)
  app.put(
    "/api/pipeline/gates",
    auth,
    requireRole("admin"),
    async (req, res) => {
      const gates = req.body && typeof req.body === "object" ? req.body : {};
      const saved = await mutateDb((db) => {
        db.stageGates = gates;
        db.audit.unshift({
          id: id("audit"),
          action: "Updated deal stage gates",
          actor: req.user.name,
          createdAt: now(),
        });
        return db.stageGates;
      });
      broadcast("pipeline.gates_updated");
      res.json(saved);
    },
  );

  // Move deal to a new stage w/ gating validation
  app.post(
    "/api/pipeline/move",
    auth,
    requireRole("admin", "member"),
    async (req, res) => {
      const { dealId, toStage } = req.body || {};
      if (!dealId || !toStage)
        return res
          .status(400)
          .json({ error: "dealId and toStage are required" });

      let gated = null;
      const saved = await mutateDb((db) => {
        const index = (db.deals || []).findIndex((d) => d.id === dealId);
        if (index < 0) return null;
        const deal = db.deals[index];
        if (deal.stage === toStage) return deal;

        // Validate the target stage against the known pipeline BEFORE persisting,
        // so a bogus stage can't orphan the deal from the pipeline and reports.
        const pipeline = Array.isArray(db.settings?.pipelineStages)
          ? db.settings.pipelineStages
          : DEFAULT_PIPELINE.map((s) => s.name);
        const stageIndex = pipeline.indexOf(toStage);
        if (stageIndex < 0) {
          gated = { invalidStage: true, warning: `Unknown stage: ${toStage}` };
          return deal;
        }

        const gates = (db.stageGates || {})[toStage];
        if (Array.isArray(gates) && gates.length) {
          const missing = gates.filter(
            (f) => deal[f] === undefined || deal[f] === null || deal[f] === "",
          );
          if (missing.length) {
            gated = { missing, fields: gates };
            return deal;
          }
        }

        const prevStage = deal.stage;
        const updated = {
          ...deal,
          stage: toStage,
          prevStage,
          probability: pipelineProbabilityFor(toStage, stageIndex),
          stageChangedAt: now(),
          updatedAt: now(),
        };
        db.deals[index] = updated;
        db.activities.unshift({
          id: id("activity"),
          title: `Deal moved ${prevStage} → ${toStage}`,
          type: "Pipeline",
          contact: deal.company || deal.title || "",
          notes: `Stage transition from ${prevStage} to ${toStage}`,
          date: now().slice(0, 10),
          dealId,
          createdAt: now(),
          updatedAt: now(),
        });
        db.audit.unshift({
          id: id("audit"),
          action: `Moved deal "${deal.title}" to ${toStage}`,
          actor: req.user.name,
          createdAt: now(),
        });
        if (toStage === "Won") {
          const contactIdx = (db.contacts || []).findIndex(
            (c) => c.company === deal.company,
          );
          if (contactIdx >= 0) {
            db.contacts[contactIdx].lifecycleStage = "Customer";
            db.contacts[contactIdx].updatedAt = now();
          }
        }
        return updated;
      });
      if (!saved) return res.status(404).json({ error: "Deal not found" });
      if (gated?.invalidStage)
        return res.status(400).json({ error: gated.warning });
      if (gated)
        return res
          .status(422)
          .json({
            error: "Stage gating requires specific fields",
            missing: gated.missing,
            fields: gated.fields,
          });
      broadcast("pipeline.deal_moved", { dealId, toStage: saved.stage });
      res.json(saved);
    },
  );
}
