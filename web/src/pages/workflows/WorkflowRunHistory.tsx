import { useEffect, useState } from "react";
import { api, type ApiError } from "../../lib/api";
import { useApp } from "../../context/AppContext";
import { Badge, Drawer, Empty } from "../../components/ui";
import { readRunPage, runStatusLabel, runTimestamp, type RunPage, type RunStatus, type WorkflowRun } from "./workflowRuns";

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <Badge tone={status === "success" ? "green" : status === "failed" ? "red" : status === "running" ? "amber" : "neutral"}>
    {runStatusLabel(status)}
  </Badge>;
}

export function WorkflowRunDetails({ run, onClose }: { run: WorkflowRun; onClose: () => void }) {
  return (
    <Drawer title="Workflow run details" subtitle={`Run ${run.id}`} width={720} onClose={onClose}>
      <dl className="detail-props">
        <div><dt>Started</dt><dd>{runTimestamp(run.startedAt)}</dd></div>
        <div><dt>Completed</dt><dd>{runTimestamp(run.completedAt)}</dd></div>
        <div><dt>Trigger event</dt><dd>{run.triggerEvent || "Unavailable"}</dd></div>
        <div><dt>Status</dt><dd><RunStatusBadge status={run.status} /></dd></div>
      </dl>
      {run.error ? <p className="workflow-run-error">{run.error}</p> : null}
      <h3>Step-by-step breakdown</h3>
      {run.steps === null ? <p>Step details are unavailable for this run.</p> : run.steps.length ? (
        <ol className="workflow-run-steps">
          {run.steps.map((step, index) => (
            <li key={`${index}-${step.nodeId}`}>
              <div className="workflow-run-step-heading">
                <strong>{step.nodeName || step.nodeId || `Step ${index + 1}`}</strong>
                <RunStatusBadge status={step.status} />
              </div>
              <p>{step.nodeType || "Node type unavailable"}{step.nodeId ? ` · ${step.nodeId}` : ""}</p>
              <time>{runTimestamp(step.executedAt)}</time>
              {step.error ? <p className="workflow-run-error">{step.error}</p> : null}
            </li>
          ))}
        </ol>
      ) : <p>No steps were recorded for this run.</p>}
    </Drawer>
  );
}

export function WorkflowRunHistory({ workflowId }: { workflowId: string }) {
  const { user } = useApp();
  const allowed = user?.role === "admin" || user?.role === "member";
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<RunPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"unavailable" | "denied" | "failed" | null>(null);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<WorkflowRun | null>(null);

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setResult(null);
    setSelected(null);
    api<unknown>(`/workflows/${encodeURIComponent(workflowId)}/runs?page=${page}&limit=20`, { signal: controller.signal })
      .then((body) => {
        const parsed = readRunPage(body, workflowId);
        if (parsed.page !== page) throw new Error("Unexpected history page");
        if (!controller.signal.aborted) setResult(parsed);
      })
      .catch((error: ApiError) => {
        if (controller.signal.aborted) return;
        setError(error.status === 404 || error.status === 501 ? "unavailable" : error.status === 403 ? "denied" : "failed");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workflowId, page, retry, allowed]);

  const refresh = <button type="button" className="btn secondary compact" disabled={loading}
    onClick={() => setRetry((value) => value + 1)}>Refresh</button>;
  if (!allowed) return <Empty icon="activity" title="Run history access restricted"
    text="Run history is available to admins and members." />;
  if (loading) return <p role="status">Loading workflow runs…</p>;
  if (error) return <Empty icon="activity"
    title={error === "unavailable" ? "Run history unavailable" : error === "denied" ? "Run history access restricted" : "Could not load workflow runs"}
    text={error === "unavailable" ? "Run history is not available for this workflow yet. Try again later."
      : error === "denied" ? "You do not have permission to view these runs." : "Try loading the history again."}
    action={error !== "denied" ? refresh : undefined} />;
  return (
    <>
      <div className="workflow-history-toolbar"><span>{result?.total || 0} recorded runs</span>{refresh}</div>
      {result?.data.length ? (
        <div className="workflow-picker-table">
          <table><caption className="sr-only">Recent workflow runs</caption>
            <thead><tr><th scope="col">Timestamp</th><th scope="col">Trigger event</th><th scope="col">Status</th></tr></thead>
            <tbody>{result.data.map((run) => (
              <tr key={run.id}>
                <td><button type="button" className="person-link" aria-label={`Open run ${run.id}`}
                  onClick={() => setSelected(run)}>{runTimestamp(run.startedAt)}</button></td>
                <td>{run.triggerEvent || "Unavailable"}</td><td><RunStatusBadge status={run.status} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty icon="activity" title="No runs on this page" text="No recorded runs were returned for this workflow on this page." />}
      {result && (result.totalPages > 1 || page > 1) ? (
        <div className="workflow-history-toolbar" aria-label="History pagination">
          <button type="button" className="btn secondary compact" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button>
          <span>Page {page} of {Math.max(page, result.totalPages)}</span>
          <button type="button" className="btn secondary compact" disabled={page >= result.totalPages} onClick={() => setPage((value) => value + 1)}>Next</button>
        </div>
      ) : null}
      {selected ? <WorkflowRunDetails run={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}
