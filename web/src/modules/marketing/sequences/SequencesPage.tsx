import { useRef, useState } from "react";
import { useApp } from "../../../context/AppContext";
import { api, json } from "../../../lib/api";
import { useResource } from "../../../lib/useResource";
import { Badge, Empty, PageHeader } from "../../../components/ui";
import { SequenceEditor } from "./SequenceEditor";
import { assertSequenceSaved, delayLabel, draftStep, editableSteps, fetchEnrollments, legacyHasEnrollments, liveEnrollment, parseSequences, sequencePayload, type Sequence } from "./sequenceModel";
import "./sequences.css";

export function SequencesPage() {
  const list = useResource<Sequence>("sequences", { all: true });
  const { user, toast } = useApp();
  const [editor, setEditor] = useState<Sequence | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState("");
  const checkBusy = useRef(false);
  const editable = user?.role === "admin" || user?.role === "member";
  async function checkForActive(sequence: Sequence) {
    const fresh = parseSequences([await api(`/sequences/${encodeURIComponent(sequence.id)}`)])[0];
    if (fresh.id !== sequence.id) throw new Error("The server returned a different sequence. Refresh before continuing.");
    if (legacyHasEnrollments(fresh)) throw new Error("This sequence has ongoing enrollments. Finish or stop them before changing its steps.");
    try {
      const enrollments = await fetchEnrollments(sequence.id, api);
      if (enrollments.some(liveEnrollment)) throw new Error("This sequence has active or paused enrollments. Finish or stop them before changing its steps.");
    } catch (failure) { if ((failure as { status?: number }).status !== 404) throw failure; }
    return fresh;
  }
  async function openEditor(sequence: Sequence) {
    if (!editable || checkBusy.current) return;
    checkBusy.current = true; setChecking(true); setNotice("");
    try {
      const fresh = await checkForActive(sequence);
      if (!editableSteps(fresh)) throw new Error("This cadence no longer contains editable email steps. Refresh the list.");
      setEditor(fresh);
    }
    catch (failure) { setNotice((failure as Error).message); }
    finally { checkBusy.current = false; setChecking(false); }
  }
  async function changeAvailability(sequence: Sequence) {
    if (!editable || checkBusy.current) return;
    checkBusy.current = true; setChecking(true); setNotice("");
    try {
      const enabled = sequence.enabled !== true;
      if (enabled) {
        if (!editableSteps(sequence)) throw new Error("This cadence cannot be enabled from the email builder");
        sequencePayload(sequence.name, true, (sequence.steps as Record<string, unknown>[]).map((step, index) => draftStep(step, String(index))));
      }
      const saved = await api<Sequence>(`/sequences/${encodeURIComponent(sequence.id)}`, json("PUT", { enabled }));
      if (saved.id !== sequence.id || saved.enabled !== enabled) throw new Error("Availability could not be confirmed. Refresh before trying again.");
      toast(enabled ? "Available for new enrollments" : "New enrollments disabled");
    } catch (failure) { setNotice((failure as Error).message); }
    finally { await list.load(); checkBusy.current = false; setChecking(false); }
  }
  async function deleteSequence(sequence: Sequence) {
    if (!editable || checkBusy.current || !confirm(`Delete ${sequence.name}?`)) return;
    checkBusy.current = true; setChecking(true); setNotice("");
    try { await checkForActive(sequence); await api(`/sequences/${encodeURIComponent(sequence.id)}`, json("DELETE")); toast("Sequence deleted"); }
    catch (failure) { setNotice((failure as Error).message); }
    finally { await list.load(); checkBusy.current = false; setChecking(false); }
  }
  return <div className="page">
    <PageHeader title="Sequences" description="Build email cadences, then enroll contacts from their record page.">
      {editable && <button type="button" className="btn primary" disabled={list.loading || Boolean(list.error) || checking} onClick={() => { setNotice(""); setEditor(null); }}>Build sequence</button>}
    </PageHeader>
    <p>Availability controls new enrollments. Disabling it does not stop contacts already enrolled.</p>
    {notice && <p role="alert">{notice}</p>}
    {checking && <p role="status">Checking ongoing enrollments…</p>}
    {list.loading ? <p role="status">Loading sequences…</p> : list.error ? <Empty icon="sequence" title="Could not load sequences" text={list.error} action={<button type="button" className="btn secondary" onClick={() => void list.load()}>Retry</button>} /> : !list.items.length ? <Empty icon="sequence" title="No sequences yet" text="Build your first cadence, then open a contact to enroll them." /> : <div className="sequence-grid">
      {list.items.map(sequence => <article className="surface sequence-card" key={sequence.id}>
        <Badge tone={sequence.enabled === true ? "green" : "neutral"}>{sequence.enabled === true ? "Enrollment enabled" : "Enrollment disabled"}</Badge>
        <h2>{sequence.name || "Untitled sequence"}</h2>
        {typeof sequence.audience === "string" && sequence.audience && <p>{sequence.audience}</p>}
        {Array.isArray(sequence.steps) ? <><p>{sequence.steps.length} steps</p><ol>{sequence.steps.map((step, index) => <li key={String(step?.id || index)}>{String(step?.subject || step?.title || `Step ${index + 1}`)}<small>{step && typeof step === "object" ? delayLabel(step) : "Unsupported step"}</small></li>)}</ol></> : <p>{typeof sequence.steps === "string" ? sequence.steps : "No structured steps"}</p>}
        {!editableSteps(sequence) && <p>This cadence uses a legacy description or actions outside the email builder. Its stored configuration is preserved.</p>}
        <footer>{editable && <><button type="button" className="btn secondary" disabled={checking || !editableSteps(sequence)} onClick={() => void openEditor(sequence)}>Edit sequence</button><button type="button" className="btn secondary" disabled={checking || (sequence.enabled !== true && !editableSteps(sequence))} onClick={() => void changeAvailability(sequence)}>{sequence.enabled === true ? "Disable enrollment" : "Enable enrollment"}</button><button type="button" className="btn secondary danger-link" disabled={checking} onClick={() => void deleteSequence(sequence)}>Delete sequence</button></>}<small>Enroll from a contact’s record.</small></footer>
      </article>)}
    </div>}
    {editor !== undefined && <SequenceEditor initial={editor || undefined} onClose={() => setEditor(undefined)} onSave={async payload => {
      if (!editable) throw new Error("Sequence editing requires admin or member access");
      if (editor) {
        const fresh = await checkForActive(editor);
        if (fresh.updatedAt && editor.updatedAt && fresh.updatedAt !== editor.updatedAt) throw new Error("This sequence changed while you were editing. Close and reopen it before saving.");
      }
      try {
        const saved = assertSequenceSaved(await api(`/sequences${editor ? `/${encodeURIComponent(editor.id)}` : ""}`, json(editor ? "PUT" : "POST", payload)), payload, editor?.id);
        setEditor(undefined); await list.load(); toast(`${saved.name} saved`);
      } catch (failure) {
        await list.load();
        const status = (failure as { status?: number }).status;
        if (status && status >= 400 && status < 500 && status !== 408) throw failure;
        throw new Error("Save could not be confirmed. Check the refreshed list before saving again.");
      }
    }} />}
  </div>;
}
