import { useState } from "react";
import { Drawer } from "../../../components/ui";
import { LEGACY_PIPELINE, pipelinePayload, type PipelineDefinition, type StageDraft } from "./pipelineDefinitions";

export function PipelineEditor({ initial, occupied, busy, onClose, onSave }: {
  initial?: PipelineDefinition; occupied: string[]; busy: boolean; onClose: () => void;
  onSave: (payload: ReturnType<typeof pipelinePayload>) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [rows, setRows] = useState<StageDraft[]>((initial?.stages || LEGACY_PIPELINE.stages).map(stage => ({ key: stage.key, label: stage.label, probability: String(stage.probability) })));
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const locked = busy || submitting;
  const close = () => { if (!locked) onClose(); };
  function change(index: number, patch: Partial<StageDraft>) { setRows(current => current.map((row, at) => at === index ? { ...row, ...patch } : row)); }
  function reorder(index: number, offset: number) {
    setRows(current => { const next = [...current]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; return next; });
  }
  async function save() {
    if (locked) return;
    setError(""); setSubmitting(true);
    try { await onSave(pipelinePayload(name, rows)); }
    catch (failure) { setError((failure as Error).message); }
    finally { setSubmitting(false); }
  }
  return <Drawer title={initial ? "Edit pipeline" : "Create pipeline"} subtitle="Define stages and their probability of winning a deal." width={760} onClose={close}
    footer={<><button type="button" className="btn secondary" disabled={locked} onClick={close}>Cancel</button><button type="button" className="btn primary" disabled={locked} onClick={() => void save()}>{locked ? "Saving…" : "Save pipeline"}</button></>}>
    <div className="pipeline-editor">
      {error && <p role="alert">{error}</p>}
      <label className="field"><span>Pipeline name *</span><input value={name} disabled={locked} onChange={event => setName(event.target.value)} /></label>
      <p>Stage order follows this list. Rename a stage without changing its existing deals. Move all deals out of a stage before removing it.</p>
      <ol className="pipeline-stage-editor">{rows.map((stage, index) => <li key={stage.key}>
        <label className="field"><span>Stage {index + 1} name *</span><input value={stage.label} disabled={locked} onChange={event => change(index, { label: event.target.value })} /></label>
        <label className="field"><span>Win probability (%) *</span><input type="number" min="0" max="100" step="any" value={stage.probability} disabled={locked} onChange={event => change(index, { probability: event.target.value })} /></label>
        <div className="pipeline-stage-actions"><button type="button" className="btn secondary compact" aria-label={`Move stage ${index + 1} up`} disabled={locked || index === 0} onClick={() => reorder(index, -1)}>Up</button>
          <button type="button" className="btn secondary compact" aria-label={`Move stage ${index + 1} down`} disabled={locked || index === rows.length - 1} onClick={() => reorder(index, 1)}>Down</button>
          <button type="button" className="btn secondary compact" aria-label={`Remove stage ${index + 1}`} disabled={locked || rows.length === 1 || occupied.includes(stage.key)} onClick={() => setRows(current => current.filter((_, at) => at !== index))}>Remove</button></div>
        {occupied.includes(stage.key) && <small>Contains deals; removal is disabled.</small>}
      </li>)}</ol>
      <button type="button" className="btn secondary" disabled={locked} onClick={() => setRows(current => [...current, { key: `stage_${crypto.randomUUID()}`, label: "", probability: "0" }])}>Add stage</button>
    </div>
  </Drawer>;
}
