import { useEffect, useRef, useState } from "react";
import type { Row } from "../../../components/records/types";
import { Badge, Drawer } from "../../../components/ui";
import { useApp } from "../../../context/AppContext";
import { api, json } from "../../../lib/api";
import { useResource } from "../../../lib/useResource";
import { assertEnrollmentSaved, delayLabel, editableSteps, enrollmentPayload, fetchEnrollments, liveEnrollment, parseSequences, type Enrollment, type Sequence } from "./sequenceModel";
import "./sequences.css";

export function ContactSequenceEnrollment({ contact }: { contact: Row }) {
  const { user } = useApp();
  const [open, setOpen] = useState(false);
  if (user?.role !== "admin" && user?.role !== "member") return null;
  return <><button type="button" className="btn secondary compact" onClick={() => setOpen(true)}>Enroll in sequence</button>
    {open && <EnrollmentPicker contact={contact} onClose={() => setOpen(false)} />}</>;
}

export function EnrollmentPicker({ contact, onClose }: { contact: Row; onClose: () => void }) {
  const list = useResource<Sequence>("sequences", { all: true });
  const { user, toast } = useApp();
  const [selected, setSelected] = useState("");
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkedId, setCheckedId] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const mounted = useRef(true), operation = useRef(false), version = useRef(0);
  const writable = user?.role === "admin" || user?.role === "member";
  const access = useRef(writable); access.current = writable;
  const sequence = list.items.find(row => row.id === selected);
  const previous = enrollments.filter(row => row.contactId === contact.id);
  const enrolled = previous.some(liveEnrollment);
  let validation = "";
  if (sequence) { try { enrollmentPayload(sequence, contact, enrollments); } catch (failure) { validation = (failure as Error).message; } }
  useEffect(() => {
    mounted.current = true;
    const refresh = (event: Event) => {
      const resource = (event as CustomEvent<{ resource?: string }>).detail?.resource;
      if ((!resource || resource === "sequences") && !operation.current) setRetry(value => value + 1);
    };
    const focus = () => { if (!operation.current) setRetry(value => value + 1); };
    window.addEventListener("tunaxa:resource-changed", refresh);
    window.addEventListener("focus", focus);
    return () => { mounted.current = false; version.current++; window.removeEventListener("tunaxa:resource-changed", refresh); window.removeEventListener("focus", focus); };
  }, []);
  useEffect(() => {
    const request = ++version.current;
    setCheckedId(""); setEnrollments([]); setError(""); setResult("");
    if (!selected || !writable) { setChecking(false); return; }
    setChecking(true);
    fetchEnrollments(selected, api).then(rows => {
      if (mounted.current && request === version.current) { setEnrollments(rows); setCheckedId(selected); }
    }).catch(failure => {
      if (mounted.current && request === version.current) setError(failure.status === 404 ? "Contact enrollment is not available on this server yet. Refresh after the enrollment API is enabled." : failure.message);
    }).finally(() => { if (mounted.current && request === version.current) setChecking(false); });
    return () => { version.current++; };
  }, [selected, retry, writable]);
  const canEnroll = writable && Boolean(sequence) && !list.loading && !list.error && checkedId === selected && !checking && !error && !busy && !validation && !enrolled && !result;
  async function enroll() {
    if (!canEnroll || !sequence || operation.current) return;
    operation.current = true; setBusy(true); setError("");
    let posted = false;
    try {
      const latest = parseSequences([await api(`/sequences/${encodeURIComponent(sequence.id)}`)])[0];
      if (latest.id !== sequence.id || (latest.updatedAt && sequence.updatedAt && latest.updatedAt !== sequence.updatedAt)) {
        await list.load();
        throw new Error("This cadence changed. Refresh enrollment status and review its current steps before enrolling.");
      }
      const current = await fetchEnrollments(sequence.id, api);
      if (!mounted.current || !access.current) return;
      const payload = enrollmentPayload(latest, contact, current);
      posted = true;
      const response = await api(`/sequences/${encodeURIComponent(sequence.id)}/enroll`, json("POST", payload));
      const message = assertEnrollmentSaved(response, sequence.id, contact.id);
      if (mounted.current) { setResult(message); toast(message); }
      window.dispatchEvent(new CustomEvent("tunaxa:resource-changed", { detail: { resource: "sequences" } }));
    } catch (failure) {
      if (mounted.current) {
        const status = (failure as { status?: number }).status;
        setError(!posted || (status && status >= 400 && status < 500 && status !== 408) ? (failure as Error).message : "Enrollment could not be confirmed. Refresh its status before trying again.");
        setCheckedId("");
      }
    } finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  const close = () => { if (!operation.current) onClose(); };
  return <Drawer title="Enroll contact in sequence" subtitle={`${contact.name || "Contact"} · ${contact.email || "No email address"}`} width={660} onClose={close}
    footer={<><button type="button" className="btn secondary" disabled={busy} onClick={close}>{result ? "Close" : "Cancel"}</button><button type="button" className="btn primary" disabled={!canEnroll} onClick={() => void enroll()}>{busy ? "Enrolling…" : "Enroll contact"}</button></>}>
    <div className="sequence-enrollment">
      {!writable && <p role="alert">Enrollment requires admin or member access.</p>}
      {list.loading ? <p role="status">Loading sequences…</p> : list.error ? <><p role="alert">{list.error}</p><button type="button" className="btn secondary" onClick={() => void list.load()}>Retry sequences</button></> : <>
        <label className="field"><span>Sequence</span><select value={selected} disabled={busy || !writable} onChange={event => setSelected(event.target.value)}><option value="">Choose a sequence</option>{list.items.map(row => <option key={row.id} value={row.id} disabled={row.enabled !== true || !editableSteps(row) || !(row.steps as unknown[]).length}>{row.name}{row.enabled !== true ? " (enrollment disabled)" : ""}</option>)}</select></label>
        {!list.items.length && <p>No sequences yet. Build a cadence on the Sequences page first.</p>}
      </>}
      {sequence && Array.isArray(sequence.steps) && <ol>{sequence.steps.map((step, index) => <li key={String(step?.id || index)}>{String(step?.subject || `Email ${index + 1}`)} — {step && typeof step === "object" ? delayLabel(step) : "Unsupported step"}{Boolean(step?.to) && <p>Recipient override: {String(step.to)}</p>}</li>)}</ol>}
      {checking && <p role="status">Checking contact enrollment…</p>}
      {validation && <p role="alert">{validation}</p>}
      {error && <><p role="alert">{error}</p><button type="button" className="btn secondary" disabled={busy || checking} onClick={() => setRetry(value => value + 1)}>Refresh enrollment status</button></>}
      {!checking && checkedId === selected && previous.length > 0 && <ul aria-label="Existing enrollments">{previous.map(row => <li key={row.id}><Badge tone={row.status === "active" ? "green" : "neutral"}>{row.status}</Badge> · {row.currentStep} steps processed{row.nextRunAt ? ` · Next scheduled: ${new Date(row.nextRunAt).toLocaleString()}` : ""}</li>)}</ul>}
      {result && <p role="status">{result}</p>}
      <p>Review the cadence before enrolling. Sending and scheduling depend on your workspace’s email service and cadence runner.</p>
    </div>
  </Drawer>;
}
