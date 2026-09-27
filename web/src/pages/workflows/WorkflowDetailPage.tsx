import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { Badge, Empty, PageHeader } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import WorkflowCanvas from "./WorkflowCanvas";
import { workflowEnabled, workflowName } from "./WorkflowPicker";

type Workflow = { id: string; name?: string; enabled?: boolean;
  event?: string; filter?: { field?: string; value?: string };
  actions?: Record<string, unknown>[] };

export function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useApp();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [tab, setTab] = useState<"Canvas" | "History">("Canvas");
  const canEdit = user?.role === "admin" || user?.role === "member";

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    setWorkflow(null);
    setTab("Canvas");
    api<Workflow>(`/workflows/${encodeURIComponent(id || "")}`, { signal: controller.signal })
      .then((result) => {
        if (!result || result.id !== id) throw new Error("Invalid workflow response");
        if (!controller.signal.aborted) setWorkflow(result);
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, retry]);

  return (
    <div className="page workflow-detail">
      <Link className="btn ghost compact" to="/workflows?picker=1">Back to workflow picker</Link>
      {loading ? <p role="status">Loading workflow…</p> : error || !workflow ? (
        <Empty icon="workflow" title="Could not open workflow" text="The workflow may be unavailable. Try again or return to the picker."
          action={<button type="button" className="btn secondary" onClick={() => setRetry((value) => value + 1)}>Retry</button>} />
      ) : (
        <>
          <PageHeader title={workflowName(workflow)}>
            <Badge tone={workflowEnabled(workflow.enabled) ? "green" : "neutral"}>
              {workflowEnabled(workflow.enabled) ? "Enabled" : "Disabled"}
            </Badge>
          </PageHeader>
          <div className="detail-tabs" role="group" aria-label="Workflow views">
            {(["Canvas", "History"] as const).map((view) => (
              <button type="button" key={view} className={tab === view ? "active" : ""}
                aria-pressed={tab === view} onClick={() => setTab(view)}>{view}</button>
            ))}
          </div>
          <section hidden={tab !== "Canvas"} aria-label="Workflow canvas">
            <p className="workflow-local-notice">{canEdit
              ? "Canvas edits are local to this view. Saving and loading saved graphs will be added separately. Leaving this page discards local edits."
              : "Read-only canvas. Saving and loading saved graphs will be added separately."}</p>
            <WorkflowCanvas key={workflow.id} readOnly={!canEdit} workflow={{
              event: typeof workflow.event === "string" ? workflow.event : "",
              filter: workflow.filter && typeof workflow.filter === "object" ? {
                field: typeof workflow.filter.field === "string" ? workflow.filter.field : "",
                value: typeof workflow.filter.value === "string" ? workflow.filter.value : "",
              } : null,
              actions: Array.isArray(workflow.actions) ? workflow.actions.filter((action) => action && typeof action === "object") : [],
            }} />
          </section>
          {tab === "History" ? (
            <section aria-label="Workflow history">
              <Empty icon="activity" title="Run history integration pending"
                text="This tab will show this workflow’s workflow_runs log once its API is available. Runs are not loaded yet." />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
