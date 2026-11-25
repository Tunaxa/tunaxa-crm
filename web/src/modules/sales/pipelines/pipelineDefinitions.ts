import type { Row } from "../../../components/records/types";

export type PipelineStage = { key: string; label: string; probability: number; order: number };
export type PipelineDefinition = {
  id: string;
  workspaceId?: string;
  name: string;
  entityType: "deal" | "lead";
  isDefault: boolean;
  stages: PipelineStage[];
  createdBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
};
export type StageDraft = { uid?: string; key: string; label: string; probability: string };
export type PipelinePayload = {
  name: string;
  entityType: "deal" | "lead";
  isDefault: boolean;
  stages: PipelineStage[];
};
export type DealPayload = Record<string, unknown> & { stage: string; probability: number; pipelineId?: string };

export const ORPHAN_PIPELINE = "__unassigned_pipeline__";
export const LEGACY_PIPELINE: PipelineDefinition = {
  id: "",
  name: "Default pipeline",
  entityType: "deal",
  isDefault: true,
  stages: [
    { key: "new", label: "New", probability: 10, order: 0 },
    { key: "qualified", label: "Qualified", probability: 25, order: 1 },
    { key: "proposal", label: "Proposal", probability: 50, order: 2 },
    { key: "negotiation", label: "Negotiation", probability: 75, order: 3 },
    { key: "won", label: "Won", probability: 100, order: 4 },
    { key: "lost", label: "Lost", probability: 0, order: 5 },
  ],
};

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const STAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const PIPELINE_MANAGER_ROLES = new Set(["admin", "owner"]);

export function canManagePipelines(role: unknown): boolean {
  return typeof role === "string" && PIPELINE_MANAGER_ROLES.has(role.trim().toLowerCase());
}

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function sanitizeFieldKey(key: string): string {
  const value = String(key ?? "").trim();
  if (!value || FORBIDDEN_KEYS.has(value.toLowerCase())) {
    throw new Error("Reserved or empty field key");
  }
  return value;
}

export function assertNoForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoForbiddenKeys(item));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new Error(`Reserved field key: ${key}`);
    }
    assertNoForbiddenKeys((value as Record<string, unknown>)[key]);
  }
}

function validateStageKey(raw: string): string {
  const key = sanitizeFieldKey(raw);
  if (key.length > 64 || !STAGE_KEY_PATTERN.test(key)) {
    throw new Error("Stage keys must be 1-64 character slugs");
  }
  return key;
}

function validateLabel(raw: string): string {
  const label = String(raw ?? "").trim();
  if (!label || label.length > 100) throw new Error("Stage labels must be 1-100 characters");
  return label;
}

function validateProbability(raw: string | number): number {
  const text = typeof raw === "number" ? String(raw) : String(raw ?? "").trim();
  if (!text) throw new Error("Win probability is required");
  const probability = Number(text);
  if (!Number.isInteger(probability) || probability < 0 || probability > 100) {
    throw new Error("Win probability must be an integer from 0 to 100");
  }
  return probability;
}

export function pipelinePayload(
  name: string,
  stages: StageDraft[],
  options: { entityType?: "deal" | "lead"; isDefault?: boolean } = {},
): PipelinePayload {
  const trimmedName = String(name ?? "").trim();
  if (!trimmedName || trimmedName.length > 100) throw new Error("Pipeline name must be 1-100 characters");
  if (!Array.isArray(stages) || stages.length < 1 || stages.length > 20) {
    throw new Error("Add between 1 and 20 stages");
  }
  const keys = Object.create(null) as Record<string, true>;
  const normalized = stages.map((stage, order) => {
    const key = validateStageKey(stage.key);
    const lower = key.toLowerCase();
    if (hasOwn(keys, lower)) throw new Error("Stage keys must be unique");
    keys[lower] = true;
    return {
      key,
      label: validateLabel(stage.label),
      probability: validateProbability(stage.probability),
      order,
    };
  });
  const payload = {
    name: trimmedName,
    entityType: options.entityType === "lead" ? "lead" : "deal",
    isDefault: Boolean(options.isDefault),
    stages: normalized,
  } as PipelinePayload;
  assertNoForbiddenKeys(payload);
  return payload;
}

export function definitionPayload(
  definition: PipelineDefinition,
  patch: Partial<Pick<PipelinePayload, "isDefault">> = {},
): PipelinePayload {
  return pipelinePayload(
    definition.name,
    definition.stages.map((stage) => ({
      key: stage.key,
      label: stage.label,
      probability: String(stage.probability),
    })),
    {
      entityType: definition.entityType,
      isDefault: patch.isDefault ?? definition.isDefault,
    },
  );
}

export function parseDefinition(value: unknown): PipelineDefinition {
  const row = (value || {}) as Partial<PipelineDefinition>;
  if (
    typeof row.id !== "string" || !row.id ||
    typeof row.name !== "string" || !row.name.trim() || row.name.length > 100 ||
    !Array.isArray(row.stages)
  ) {
    throw new Error("Invalid pipeline definition response");
  }
  const entityType = row.entityType === "lead" ? "lead" : "deal";
  const keys = Object.create(null) as Record<string, true>;
  const stages = row.stages.map((stage) => {
    if (!stage || typeof stage !== "object") throw new Error("Invalid pipeline stage response");
    const key = validateStageKey(stage.key);
    const lower = key.toLowerCase();
    if (hasOwn(keys, lower)) throw new Error("Pipeline contains duplicate stage keys");
    keys[lower] = true;
    if (
      !Number.isInteger(stage.order) || stage.order < 0 || stage.order > 1000 ||
      !Number.isFinite(stage.probability) || !Number.isInteger(stage.probability) ||
      stage.probability < 0 || stage.probability > 100
    ) {
      throw new Error("Invalid pipeline stage response");
    }
    return { key, label: validateLabel(stage.label), probability: stage.probability, order: stage.order };
  }).sort((a, b) => a.order - b.order);
  if (stages.length < 1 || stages.length > 20) throw new Error("Invalid pipeline stage response");
  return {
    id: row.id,
    workspaceId: typeof row.workspaceId === "string" ? row.workspaceId : undefined,
    name: row.name,
    entityType,
    isDefault: Boolean(row.isDefault),
    stages,
    createdBy: typeof row.createdBy === "string" ? row.createdBy : null,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : undefined,
  };
}

export function parseDefinitions(value: unknown): PipelineDefinition[] {
  if (!Array.isArray(value)) throw new Error("Invalid pipeline list response");
  const ids = Object.create(null) as Record<string, true>;
  return value.map((item) => {
    const row = parseDefinition(item);
    if (hasOwn(ids, row.id)) throw new Error("Pipeline list contains duplicate IDs");
    ids[row.id] = true;
    return row;
  });
}

export function defaultDefinition(definitions: PipelineDefinition[]): PipelineDefinition | null {
  return definitions.find((definition) => definition.isDefault) ?? definitions[0] ?? null;
}

export function dealPipelineId(row: Row, definitions: PipelineDefinition[]): string {
  const value = row.pipelineId ?? row.pipeline_id;
  if (typeof value === "string" && value.trim()) return value.trim();
  return defaultDefinition(definitions)?.id || "";
}

export function pipelineDeals(rows: Row[], pipelineId: string, definitions: PipelineDefinition[]): Row[] {
  if (!definitions.length) return rows;
  return rows.filter((row) => {
    const id = dealPipelineId(row, definitions);
    return pipelineId === ORPHAN_PIPELINE
      ? !definitions.some((definition) => definition.id === id)
      : id === pipelineId;
  });
}

export function stageForDeal(row: Row, definition: PipelineDefinition): PipelineStage | undefined {
  const value = String(row.stage ?? "");
  if (!value && !definition.id) return definition.stages[0];
  return definition.stages.find((stage) => stage.key === value) ||
    definition.stages.find((stage) => stage.key.toLowerCase() === value.toLowerCase()) ||
    definition.stages.find((stage) => stage.label.toLowerCase() === value.toLowerCase());
}

export function occupiedStageKeys(rows: Row[], definition: PipelineDefinition): string[] {
  return [...new Set(rows.map((row) => stageForDeal(row, definition)?.key).filter((key): key is string => Boolean(key)))];
}

export function validateStageRemoval(previous: PipelineDefinition, next: PipelineStage[], rows: Row[]): void {
  const occupied = occupiedStageKeys(rows, previous);
  const removed = previous.stages.find((stage) => occupied.includes(stage.key) && !next.some((item) => item.key === stage.key));
  if (removed) throw new Error(`Move the deals out of ${removed.label} before removing that stage`);
  const renamed = previous.stages.find((stage) =>
    next.some((item) => item.key === stage.key && item.label !== stage.label) &&
    rows.some((row) => stageForDeal(row, previous)?.key === stage.key && String(row.stage).toLowerCase() !== stage.key.toLowerCase()));
  if (renamed) throw new Error(`Move legacy deals out of ${renamed.label} and back into it before renaming that stage`);
}

function cleanDealData(data: Record<string, unknown>): Record<string, unknown> {
  assertNoForbiddenKeys(data);
  const clean = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    const safe = sanitizeFieldKey(key);
    clean[safe] = data[key];
  }
  return clean;
}

export function dealPayload(data: Record<string, unknown>, definition: PipelineDefinition): DealPayload {
  const clean = cleanDealData(data);
  const stage = definition.stages.find((item) => item.key === clean.stage);
  if (!stage) throw new Error("Choose a valid stage for this pipeline");
  const payload = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(clean)) {
    if (!["stage", "pipelineId", "pipeline_id", "probability"].includes(key)) payload[key] = value;
  }
  payload.stage = stage.key;
  payload.probability = stage.probability;
  if (definition.id) payload.pipelineId = definition.id;
  return payload as DealPayload;
}

export function importDealPayload(data: Record<string, unknown>, definition: PipelineDefinition): DealPayload {
  const stage = data.stage
    ? stageForDeal({ id: "", ...data } as Row, definition)
    : definition.stages[0];
  if (!stage) throw Object.assign(new Error("Choose a valid stage for the selected pipeline"), { status: 400 });
  return dealPayload({ ...data, stage: stage.key }, definition);
}

export function checkDealSave(saved: Row, payload: DealPayload): void {
  if (
    !saved || typeof saved.id !== "string" || !saved.id ||
    saved.stage !== payload.stage ||
    (payload.pipelineId && saved.pipelineId !== payload.pipelineId && saved.pipeline_id !== payload.pipelineId)
  ) {
    throw new Error("The server did not confirm this deal's pipeline and stage. Reload before trying again.");
  }
}
