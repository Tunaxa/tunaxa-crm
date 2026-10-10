import { useRef, useState } from "react";
import { Drawer } from "../../../components/ui";
import { draftStep, sequencePayload, type Sequence, type StepDraft } from "./sequenceModel";

export function SequenceEditor({ initial, onClose, onSave }: {
  initial?: Sequence; onClose: () => void; onSave: (payload: ReturnType<typeof sequencePayload>) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [enabled, setEnabled] = useState(initial?.enabled === true);
  const [steps, setSteps] = useState<StepDraft[]>(initial ? (initial.steps as Record<string, unknown>[]).map(source => draftStep(source)) : [draftStep()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const close = () => { if (!saving.current) onClose(); };
  const change = (key: string, patch: Partial<StepDraft>) => setSteps(rows => rows.map(row => row.key === key ? { ...row, ...patch } : row));
  const reorder = (index: number, offset: number) => setSteps(rows => { const next = [...rows]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; return next; });
  async function save() {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try { await onSave(sequencePayload(name, enabled, steps)); }
    catch (failure) { setError((failure as Error).message); }
    finally { saving.current = false; setBusy(false); }
  }
  return <Drawer title={initial ? "Edit sequence" : "Build sequence"} subtitle="Create an ordered email cadence for your contacts." width={780} onClose={close}
    footer={<><button type="button" className="btn secondary" disabled={busy} onClick={close}>Cancel</button><button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save sequence"}</button></>}>
    <div className="sequence-editor">
      {error && <p role="alert">{error}</p>}
      <label className="field"><span>Sequence name *</span><input value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label className="toggle-row"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} /><span>Available for contact enrollment</span></label>
      <p>Each delay is the wait before that step. Use contact properties such as {"{{first_name}}"} or {"{{email}}"} in your subject and message.</p>
      <ol className="sequence-step-editor">{steps.map((step, index) => <li key={step.key}>
        <h3>Email {index + 1}</h3>
        <div className="sequence-delay">{(["delayDays", "delayHours", "delayMinutes"] as const).map(field => <label className="field" key={field}><span>{field.replace("delay", "Wait ")}</span><input type="number" min="0" max={field === "delayHours" ? 23 : field === "delayMinutes" ? 59 : undefined} step="1" value={step[field]} disabled={busy} onChange={event => change(step.key, { [field]: event.target.value })} /></label>)}</div>
        <label className="field"><span>Subject *</span><input value={step.subject} disabled={busy} onChange={event => change(step.key, { subject: event.target.value })} /></label>
        <label className="field"><span>Message *</span><textarea rows={5} value={step.body} disabled={busy} onChange={event => change(step.key, { body: event.target.value })} /></label>
        {Boolean(step.source.to) && <p>Existing recipient override: {String(step.source.to)}</p>}
        <div className="sequence-step-actions"><button type="button" className="btn secondary compact" aria-label={`Move email ${index + 1} up`} disabled={busy || index === 0} onClick={() => reorder(index, -1)}>Up</button><button type="button" className="btn secondary compact" aria-label={`Move email ${index + 1} down`} disabled={busy || index === steps.length - 1} onClick={() => reorder(index, 1)}>Down</button><button type="button" className="btn secondary compact" aria-label={`Remove email ${index + 1}`} disabled={busy || steps.length === 1} onClick={() => setSteps(rows => rows.filter(row => row.key !== step.key))}>Remove</button></div>
      </li>)}</ol>
      <button type="button" className="btn secondary" disabled={busy} onClick={() => setSteps(rows => [...rows, draftStep()])}>Add email step</button>
    </div>
  </Drawer>;
}
