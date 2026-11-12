export type RunStatus = "success" | "failed" | "running" | "skipped" | "unknown";
export type RunStep = { nodeId: string; nodeName: string; nodeType: string; status: RunStatus; error: string; executedAt: string };
export type WorkflowRun = { id: string; triggerEvent: string; status: RunStatus; startedAt: string;
  completedAt: string; error: string; steps: RunStep[] | null };
export type RunPage = { data: WorkflowRun[]; page: number; total: number; totalPages: number };
const text = (value: unknown) => typeof value === "string" ? value : "";
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid run history response");
  return value as Record<string, unknown>;
};
const status = (value: unknown): RunStatus =>
  typeof value === "string" && ["success", "failed", "running", "skipped"].includes(value) ? value as RunStatus : "unknown";

export function runStatusLabel(value: RunStatus) {
  return { success: "Success", failed: "Failed", running: "Running", skipped: "Skipped", unknown: "Unknown" }[value];
}
export function runTimestamp(value: string) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unavailable";
}

export function readRunPage(value: unknown, workflowId: string): RunPage {
  const page = object(value);
  if (!Array.isArray(page.data) || !Number.isInteger(page.page) || Number(page.page) < 1 ||
      !Number.isInteger(page.total) || Number(page.total) < 0 ||
      !Number.isInteger(page.totalPages) || Number(page.totalPages) < 0)
    throw new Error("Invalid run history pagination");
  const ids = new Set<string>();
  const data = page.data.map((raw): WorkflowRun => {
    const run = object(raw);
    if (typeof run.id !== "string" || !run.id || ids.has(run.id) || run.workflow_id !== workflowId)
      throw new Error("Invalid workflow run reference");
    ids.add(run.id);
    let steps: RunStep[] | null = null;
    if (Array.isArray(run.steps)) {
      try {
        steps = run.steps.map((rawStep): RunStep => {
          const step = object(rawStep);
          return { nodeId: text(step.nodeId), nodeName: text(step.nodeName), nodeType: text(step.nodeType),
            status: status(step.status), error: text(step.error), executedAt: text(step.executedAt) };
        });
      } catch { steps = null; }
    }
    return { id: run.id, triggerEvent: text(run.trigger_event), status: status(run.status),
      startedAt: text(run.started_at), completedAt: text(run.completed_at), error: text(run.error_message), steps };
  });
  return { data, page: Number(page.page), total: Number(page.total), totalPages: Number(page.totalPages) };
}
