import type { Row } from "../../../components/records/types";

export type PipelineStage = { key: string; label: string; probability: number; order: number };
export type PipelineDefinition = { id: string; name: string; stages: PipelineStage[] };
export type StageDraft = { key: string; label: string; probability: string };
export const ORPHAN_PIPELINE = "__unassigned_pipeline__";
export const LEGACY_PIPELINE: PipelineDefinition = { id: "", name: "Default pipeline", stages: [
  { key: "new", label: "New", probability: 10, order: 0 },
  { key: "qualified", label: "Qualified", probability: 25, order: 1 },
  { key: "proposal", label: "Proposal", probability: 50, order: 2 },
  { key: "negotiation", label: "Negotiation", probability: 75, order: 3 },
  { key: "won", label: "Won", probability: 100, order: 4 },
  { key: "lost", label: "Lost", probability: 0, order: 5 },
] };
export function pipelinePayload(name: string, stages: StageDraft[]) {
  if (!name.trim()) throw new Error("Pipeline name is required");
  if (!stages.length) throw new Error("Add at least one stage");
  const keys = new Set<string>(), labels = new Set<string>();
  const normalized = stages.map((stage, order) => {
    const key = stage.key.trim(), label = stage.label.trim();
    if (!key || !label) throw new Error(`Stage ${order + 1} needs a name and a key`);
    if (keys.has(key.toLowerCase())) throw new Error("Stage keys must be unique");
    if (labels.has(label.toLowerCase())) throw new Error("Stage names must be unique");
    keys.add(key.toLowerCase()); labels.add(label.toLowerCase());
    const probability = Number(stage.probability);
    if (!stage.probability.trim() || !Number.isFinite(probability) || probability < 0 || probability > 100) throw new Error(`Probability for ${label} must be between 0 and 100`);
    return { key, label, probability, order };
  });
  return { name: name.trim(), stages: normalized };
}
export function parseDefinition(value: unknown): PipelineDefinition {
  const row = value as PipelineDefinition;
  if (!row || typeof row.id !== "string" || !row.id || typeof row.name !== "string" || !row.name.trim() || !Array.isArray(row.stages)) throw new Error("Invalid pipeline definition response");
  const stages = row.stages.map(stage => {
    if (!stage || typeof stage.key !== "string" || !stage.key || typeof stage.label !== "string" || !stage.label || typeof stage.probability !== "number" || !Number.isFinite(stage.probability) || stage.probability < 0 || stage.probability > 100 || !Number.isFinite(stage.order)) throw new Error("Invalid pipeline stage response");
    return { ...stage };
  }).sort((a, b) => a.order - b.order);
  if (new Set(stages.map(stage => stage.key.toLowerCase())).size !== stages.length) throw new Error("Pipeline contains duplicate stage keys");
  return { id: row.id, name: row.name, stages };
}
export function parseDefinitions(value: unknown): PipelineDefinition[] {
  if (!Array.isArray(value)) throw new Error("Invalid pipeline list response");
  const rows = value.map(parseDefinition);
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("Pipeline list contains duplicate IDs");
  return rows;
}
export function dealPipelineId(row: Row, definitions: PipelineDefinition[]): string {
  const value = row.pipelineId ?? row.pipeline_id;
  return typeof value === "string" && value ? value : definitions[0]?.id || "";
}
export function pipelineDeals(rows: Row[], pipelineId: string, definitions: PipelineDefinition[]): Row[] {
  if (!definitions.length) return rows;
  return rows.filter(row => {
    const id = dealPipelineId(row, definitions);
    return pipelineId === ORPHAN_PIPELINE ? !definitions.some(definition => definition.id === id) : id === pipelineId;
  });
}
export function stageForDeal(row: Row, definition: PipelineDefinition): PipelineStage | undefined {
  const value = String(row.stage ?? "");
  if (!value && !definition.id) return definition.stages[0];
  return definition.stages.find(stage => stage.key === value)
    || definition.stages.find(stage => stage.key.toLowerCase() === value.toLowerCase())
    || definition.stages.find(stage => stage.label.toLowerCase() === value.toLowerCase());
}
export function occupiedStageKeys(rows: Row[], definition: PipelineDefinition): string[] {
  return [...new Set(rows.map(row => stageForDeal(row, definition)?.key).filter((key): key is string => Boolean(key)))];
}
export function validateStageRemoval(previous: PipelineDefinition, next: PipelineStage[], rows: Row[]) {
  const occupied = occupiedStageKeys(rows, previous);
  const removed = previous.stages.find(stage => occupied.includes(stage.key) && !next.some(item => item.key === stage.key));
  if (removed) throw new Error(`Move the deals out of ${removed.label} before removing that stage`);
  const renamed = previous.stages.find(stage => next.some(item => item.key === stage.key && item.label !== stage.label)
    && rows.some(row => stageForDeal(row, previous)?.key === stage.key && String(row.stage).toLowerCase() !== stage.key.toLowerCase()));
  if (renamed) throw new Error(`Move legacy deals out of ${renamed.label} and back into it before renaming that stage`);
}
export function dealPayload(data: Record<string, unknown>, definition: PipelineDefinition) {
  const stage = definition.stages.find(item => item.key === data.stage);
  if (!stage) throw new Error("Choose a valid stage for this pipeline");
  return { ...data, ...(definition.id ? { pipelineId: definition.id } : {}), stage: stage.key, probability: stage.probability };
}
export function importDealPayload(data: Record<string, unknown>, definition: PipelineDefinition) {
  const stage = data.stage ? stageForDeal({ id: "", ...data }, definition) : definition.stages[0];
  if (!stage) throw Object.assign(new Error("Choose a valid stage for the selected pipeline"), { status: 400 });
  return dealPayload({ ...data, stage: stage.key }, definition);
}
export function checkDealSave(saved: Row, payload: ReturnType<typeof dealPayload>) {
  if (!saved || !saved.id || saved.stage !== payload.stage || (payload.pipelineId && saved.pipelineId !== payload.pipelineId && saved.pipeline_id !== payload.pipelineId)) throw new Error("The server did not confirm this deal's pipeline and stage. Reload before trying again.");
}
