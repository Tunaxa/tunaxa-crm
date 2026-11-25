import { useRef, useState } from "react";
import { Drawer } from "../../../components/ui";
import { draftStep, sequencePayload, type Sequence, type StepDraft } from "./sequenceModel";

export function SequenceEditor({ initial, onClose, onSave }: {
  initial?: Sequence; onClose: () => void; onSave: (payload: ReturnType<typeof sequencePayload>) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [enabled, setEnabled] = useState(initial?.enabled === true);
  const [steps, setSteps] = useState<StepDraft[]>(() => initial && Array.isArray(initial.steps)
    ? (initial.steps as Record<string, unknown>[]).map(source => draftStep(source))
    : [draftStep()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const close = () => { if (!saving.current) onClose(); };
  const change = (key: string, patch: Partial<StepDraft>) => setSteps(rows => rows.map(row => row.key === key ? { ...row, ...patch } : row));
  const reorder = (visibleIndex: number, offset: number) => setSteps(rows => {
    const positions = rows.map((row, index) => row.supported ? index : -1).filter(index => index >= 0);
    const from = positions[visibleIndex];
    const to = positions[visibleIndex + offset];
    if (from === undefined || to === undefined) return rows;
    const next = [...rows];
    [next[from], next[to]] = [next[to], next[from]];
    return next;
  });
  const remove = (key: string) => setSteps(rows => rows.filter(row => row.key !== key || !row.supported));
  const editable = steps.map((step, index) => ({ step, index })).filter(entry => entry.step.supported);
  const preserved = steps.length - editable.length;

  async function save() {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      await onSave(sequencePayload(name, enabled, steps, initial?.exitRules !== undefined ? { exitRules: initial.exitRules } : {}));
    }
    catch (failure) { setError((failure as Error).message); }
    finally { saving.current = false; setBusy(false); }
  }

  return <Drawer title={initial ? "Edit sequence" : "Build sequence"} subtitle="Create an ordered email cadence for your contacts." width={780} onClose={close}
    footer={<><button type="button" className="btn secondary" disabled={busy} onClick={close}>Cancel</button><button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save sequence"}</button></>}>
    <div className="sequence-editor">
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Saving sequence…</p>}
      <label className="field"><span>Sequence name *</span><input value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label className="toggle-row"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} /><span>Available for contact enrollment</span></label>
      <p>Use contact properties such as {"{{firstName}}"}, {"{{name}}"} or {"{{email}}"} in your subject and message.</p>
      {preserved > 0 && <p role="status">{preserved} legacy step{preserved === 1 ? "" : "s"} will be preserved unchanged.</p>}
      <ol className="sequence-step-editor">{editable.map(({ step }, visibleIndex) => <li key={step.key}>
        <h3>Email {visibleIndex + 1}</h3>
        <div className="sequence-delay">{(["delayDays", "delayHours", "delayMinutes"] as const).map(field => <label className="field" key={field}><span>{field.replace("delay", "Wait ")}</span><input type="number" min="0" max={field === "delayHours" ? 23 : field === "delayMinutes" ? 59 : 365} step="1" value={step[field]} disabled={busy} onChange={event => change(step.key, { [field]: event.target.value })} /></label>)}</div>
        <label className="field"><span>Subject *</span><input value={step.subject} disabled={busy} onChange={event => change(step.key, { subject: event.target.value })} /></label>
        <label className="field"><span>Message *</span><textarea rows={5} value={step.body} disabled={busy} onChange={event => change(step.key, { body: event.target.value })} /></label>
        {Boolean(step.source.to) && <p>Existing recipient override: {String(step.source.to)}</p>}
        <div className="sequence-step-actions"><button type="button" className="btn secondary compact" aria-label={`Move email ${visibleIndex + 1} up`} disabled={busy || visibleIndex === 0} onClick={() => reorder(visibleIndex, -1)}>Move Up</button><button type="button" className="btn secondary compact" aria-label={`Move email ${visibleIndex + 1} down`} disabled={busy || visibleIndex === editable.length - 1} onClick={() => reorder(visibleIndex, 1)}>Move Down</button><button type="button" className="btn secondary compact" aria-label={`Remove email ${visibleIndex + 1}`} disabled={busy || editable.length === 1} onClick={() => remove(step.key)}>Remove</button></div>
      </li>)}</ol>
      <button type="button" className="btn secondary" disabled={busy} onClick={() => setSteps(rows => [...rows, draftStep()])}>Add email step</button>
    </div>
  </Drawer>;
}
