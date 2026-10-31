import { Badge, Drawer, Empty } from "../../components/ui";
import "./workflowViews.css";

export type WorkflowRecord = { id: string; name?: unknown; enabled?: unknown; lastRunAt?: unknown };
export function workflowName(workflow: WorkflowRecord) {
  return typeof workflow.name === "string" && workflow.name.trim() ? workflow.name : "Untitled workflow";
}
export function workflowEnabled(value: unknown) {
  return value === true || value === "true" || value === "1";
}
export function workflowLastRun(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "Unavailable";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unavailable";
}

export function WorkflowPicker({ workflows, loading, error, onRetry, onClose, onSelect }: {
  workflows: WorkflowRecord[]; loading: boolean; error: string | null;
  onRetry: () => void; onClose: () => void; onSelect: (id: string) => void;
}) {
  return (
    <Drawer title="Choose a workflow" subtitle="Select a workflow to open its Canvas and History tabs."
      width={760} onClose={onClose}>
      {loading ? <p role="status">Loading workflows…</p> : error ? (
        <Empty icon="workflow" title="Could not load workflows" text="Try loading the list again."
          action={<button type="button" className="btn secondary" onClick={onRetry}>Retry</button>} />
      ) : workflows.length ? (
        <div className="workflow-picker-table">
          <table>
            <caption className="sr-only">Available workflows</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Last Run</th></tr></thead>
            <tbody>{workflows.map((workflow) => (
              <tr key={workflow.id}>
                <td><button type="button" className="person-link" onClick={() => onSelect(workflow.id)}>
                  {workflowName(workflow)}
                </button></td>
                <td><Badge tone={workflowEnabled(workflow.enabled) ? "green" : "neutral"}>
                  {workflowEnabled(workflow.enabled) ? "Enabled" : "Disabled"}
                </Badge></td>
                <td>{workflowLastRun(workflow.lastRunAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty icon="workflow" title="No workflows" text="Create a workflow before opening its canvas." />}
    </Drawer>
  );
}
