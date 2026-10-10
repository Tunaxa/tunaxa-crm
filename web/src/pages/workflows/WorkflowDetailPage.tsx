import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, json } from "../../lib/api";
import { Badge, Empty, PageHeader } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import WorkflowCanvas from "./WorkflowCanvas";
import { workflowEnabled, workflowName } from "./WorkflowPicker";
import { graphFingerprint, graphPayload, readWorkflowGraph, type WorkflowGraph } from "./workflowGraph";
import { WorkflowRunHistory } from "./WorkflowRunHistory";

type Workflow = { id: string; name?: string; enabled?: boolean;
  event?: string; filter?: { field?: string; value?: string };
  actions?: Record<string, unknown>[] };

export function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user, toast } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [tab, setTab] = useState<"Canvas" | "History">("Canvas");
  const canEdit = user?.role === "admin" || user?.role === "member";
  const [initialGraph, setInitialGraph] = useState<WorkflowGraph | null>(null);
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const dirty = graph !== null && graphFingerprint(graph) !== saved;
  const updateGraph = useCallback((next: WorkflowGraph) => setGraph(next), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    setWorkflow(null);
    setInitialGraph(null);
    setGraph(null);
    setSaved("");
    setTab("Canvas");
    api<Workflow>(`/workflowbuilder/${encodeURIComponent(id || "")}`, { signal: controller.signal })
      .then((result) => {
        if (!result || result.id !== id) throw new Error("Invalid workflow response");
        const loaded = readWorkflowGraph(result);
        if (!controller.signal.aborted) {
          setWorkflow(result);
          setInitialGraph(loaded);
          setGraph(loaded);
          setSaved(graphFingerprint(loaded));
        }
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, retry]);

  useEffect(() => {
    if (!dirty && !saving) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const linkClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement) || target.target === "_blank" || target.hasAttribute("download")) return;
      if (target.href === window.location.href) return;
      if (saving || !window.confirm("Discard unsaved canvas changes?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // HashRouter navigation can come from sidebar links or the browser Back button.
    const hash = window.location.hash;
    const historyState = window.history.state;
    const hashChange = () => {
      if (window.location.hash === hash) return;
      if (saving || !window.confirm("Discard unsaved canvas changes?")) {
        window.history.replaceState(historyState, "", hash);
        navigate(`${location.pathname}${location.search}`, { replace: true });
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("hashchange", hashChange);
    document.addEventListener("click", linkClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("hashchange", hashChange);
      document.removeEventListener("click", linkClick, true);
    };
  }, [dirty, saving, navigate, location.pathname, location.search]);

  async function save() {
    if (!graph || !dirty || !canEdit || pending.current) return;
    pending.current = true;
    setSaving(true);
    const payload = graphPayload(graph);
    const snapshot = graphFingerprint(payload);
    try {
      const result = await api<Workflow>(`/workflowbuilder/${encodeURIComponent(id || "")}`, json("PUT", payload));
      if (!result || result.id !== id || graphFingerprint(readWorkflowGraph(result)) !== snapshot)
        throw new Error("The server did not confirm the saved graph. Your edits are still available; retry saving.");
      setSaved(snapshot);
      toast("Workflow canvas saved");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save workflow", "error");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="page workflow-detail">
      <Link className="btn ghost compact" to="/workflows?picker=1">Back to workflow picker</Link>
      {loading ? <p role="status">Loading workflow…</p> : error || !workflow ? (
        <Empty icon="workflow" title="Could not open workflow" text="The workflow may be unavailable. Try again or return to the picker."
          action={<button type="button" className="btn secondary" onClick={() => setRetry((value) => value + 1)}>Retry</button>} />
      ) : (
        <>
          <PageHeader title={workflowName(workflow)}>
            <span role="status" aria-live="polite">{saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>
            {canEdit ? <button type="button" className="btn primary" disabled={!dirty || saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button> : null}
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
            <p className="workflow-local-notice">{canEdit ? "Save your canvas changes before leaving this workflow." : "Read-only canvas."}</p>
            <WorkflowCanvas key={workflow.id} initialGraph={initialGraph || undefined} onGraphChange={updateGraph}
              readOnly={!canEdit || saving} workflow={{
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
              <WorkflowRunHistory key={workflow.id} workflowId={workflow.id} />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
