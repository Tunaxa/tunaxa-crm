import { useEffect, useRef, useState } from "react";
import { api, json } from "../lib/api";
import "./lifecycleStage.css";

type StageResponse = { stages: { stage: string }[]; requiredByStage?: Record<string, string[]> };
export function LifecycleStage({ recordId, stage, disabled, onSaved }: {
  recordId: string; stage?: string; disabled: boolean;
  onSaved: (record: Record<string, any>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<StageResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const route = useRef(recordId);
  route.current = recordId;
  const current = stage || "Subscriber";
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setData(null); setError("");
    api<StageResponse>("/lifecycle/stages", { signal: controller.signal })
      .then((result) => {
        if (!Array.isArray(result.stages) || !result.stages.length || result.stages.some((item) => typeof item.stage !== "string")) throw new Error("Invalid lifecycle stages response");
        if (!controller.signal.aborted) setData(result);
      })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message || "Could not load lifecycle stages."); });
    return () => controller.abort();
  }, [open, retry, recordId]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { setOpen(false); trigger.current?.focus(); }
    };
    const outside = (event: MouseEvent) => {
      if (!busy && !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("mousedown", outside);
    return () => { document.removeEventListener("keydown", close); document.removeEventListener("mousedown", outside); };
  }, [open, busy]);
  async function change(next: string) {
    if (busy || disabled || next === current) return;
    setBusy(true); setError("");
    const requestedId = recordId;
    try {
      const saved = await api<Record<string, any>>("/lifecycle/transition", json("POST", { recordId, stage: next }));
      if (route.current !== requestedId) return;
      onSaved(saved); setOpen(false); trigger.current?.focus();
    } catch (failure) {
      if (route.current === requestedId) setError((failure as Error).message || "Could not update lifecycle stage.");
    } finally { if (route.current === requestedId) setBusy(false); }
  }
  const index = data?.stages.findIndex((item) => item.stage === current) ?? -1;
  return <div className="lifecycle-row" ref={root}>
    <span>Lifecycle stage</span>
    <button ref={trigger} type="button" className={`lifecycle-badge lifecycle-${current.toLowerCase()}`}
      disabled={disabled || busy} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>{current}</button>
    {open && <div className="lifecycle-popover" role="dialog" aria-label="Change lifecycle stage">
      <div className="lifecycle-heading"><strong>Lifecycle stage</strong><button type="button" disabled={busy} aria-label="Close lifecycle picker" onClick={() => { setOpen(false); trigger.current?.focus(); }}>×</button></div>
      {!data && !error && <p role="status">Loading stages…</p>}
      {data && <><div role="progressbar" aria-label="Lifecycle progress" aria-valuemin={0} aria-valuemax={data.stages.length} aria-valuenow={Math.max(0, index + 1)} aria-valuetext={current} className="lifecycle-progress"><span style={{ width: `${Math.max(0, index + 1) / data.stages.length * 100}%` }} /></div>
        <ol>{data.stages.map((item, position) => <li key={item.stage}><button type="button" disabled={disabled || busy || position < index || item.stage === current} aria-current={item.stage === current ? "step" : undefined} onClick={() => change(item.stage)}>{item.stage}{item.stage === current ? " (current)" : ""}</button>
          {!!data.requiredByStage?.[item.stage]?.length && <small>Requires: {data.requiredByStage[item.stage].join(", ")}</small>}</li>)}</ol>
        <small>Stages can only move forward.</small></>}
      {busy && <p role="status">Saving stage…</p>}
      {error && <p role="alert">{error} {!data && <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button>}</p>}
    </div>}
  </div>;
}
