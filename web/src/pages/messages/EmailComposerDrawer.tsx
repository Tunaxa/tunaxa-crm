import { useEffect, useId, useRef, useState } from "react";
import { Drawer } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import { api, json } from "../../lib/api";
import { canSend, confirmedMail, contactOptions, mailStatus, mailTemplates, sendPayload, type ContactOption, type MailTemplate } from "./composerModel";
import { RichMessageEditor } from "./RichMessageEditor";
import "./emailComposer.css";

export function EmailComposerDrawer({ recipient = "", subject = "", onClose, onSent }: { recipient?: string; subject?: string; onClose: () => void; onSent: (message: { id: string; status: string; [key: string]: unknown }) => void }) {
  const { user, toast } = useApp(), id = useId();
  const [to, setTo] = useState(recipient), [title, setTitle] = useState(subject), [body, setBody] = useState(""), [html, setHtml] = useState("");
  const [contacts, setContacts] = useState<ContactOption[]>([]), [contactError, setContactError] = useState(false);
  const [templates, setTemplates] = useState<MailTemplate[]>([]), [templateId, setTemplateId] = useState(""), [templateError, setTemplateError] = useState(false), [templateLoading, setTemplateLoading] = useState(true), [retry, setRetry] = useState(0);
  const [version, setVersion] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const running = useRef(false), dirty = useRef(false), alive = useRef(true), attempt = useRef({ fingerprint: "", key: "" });
  const allowed = canSend(user?.role);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const abort = new AbortController(); setContacts([]); setContactError(false);
    if (to.trim().length < 2) return;
    const timer = window.setTimeout(() => {
      api(`/contacts?q=${encodeURIComponent(to.trim())}&page=1&limit=20`, { signal: abort.signal }).then(contactOptions)
        .then(rows => { if (!abort.signal.aborted) setContacts(rows); }).catch(() => { if (!abort.signal.aborted) setContactError(true); });
    }, 250);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [to]);
  useEffect(() => {
    const abort = new AbortController(); setTemplateLoading(true); setTemplateError(false);
    api("/templates", { signal: abort.signal }).then(mailTemplates).then(rows => { if (!abort.signal.aborted) setTemplates(rows); })
      .catch(() => { if (!abort.signal.aborted) setTemplateError(true); }).finally(() => { if (!abort.signal.aborted) setTemplateLoading(false); });
    return () => abort.abort();
  }, [retry]);
  function close() { if (!running.current && (!dirty.current || confirm("Discard this email draft?"))) onClose(); }
  async function send() {
    if (running.current || !allowed) return;
    setError(""); let payload: ReturnType<typeof sendPayload>;
    try {
      const contact = contacts.find(row => row.email === to.trim().toLowerCase())?.name || "";
      const fingerprint = JSON.stringify([to.trim().toLowerCase(), title.trim(), body.trim(), html]);
      if (attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: `email_${crypto.randomUUID()}` };
      payload = sendPayload(to, title, body, html, attempt.current.key, contact);
    } catch (failure) { setError((failure as Error).message); return; }
    running.current = true; setBusy(true);
    try {
      const saved = confirmedMail(await api("/messages/send", json("POST", payload)), payload);
      if (alive.current) { dirty.current = false; toast(mailStatus(saved.status)); onSent(saved); onClose(); }
    } catch (failure) {
      if (alive.current) setError((failure as { status?: number }).status === 403 ? "You do not have permission to send emails." : failure instanceof Error && /Delivery failed|Send could not be confirmed/u.test(failure.message) ? failure.message : "Send could not be confirmed. Check the inbox before retrying; your draft is retained.");
    } finally { running.current = false; if (alive.current) setBusy(false); }
  }
  return <div className="email-compose-surface"><Drawer title="Compose email" onClose={close} width={560}>
    {error && <p role="alert">{error}</p>}{!allowed && <p role="alert">You have read-only email access.</p>}
    <form onSubmit={event => { event.preventDefault(); void send(); }} onChangeCapture={() => { dirty.current = true; }}>
      <label className="field"><span>To *</span><input type="email" required list={`${id}-contacts`} value={to} disabled={busy || !allowed} onChange={event => setTo(event.target.value)} autoComplete="off" placeholder="Search contacts or enter an email" /></label>
      <datalist id={`${id}-contacts`}>{contacts.map(contact => <option key={contact.id} value={contact.email}>{contact.name}</option>)}</datalist>
      {contactError && <small role="status">Contact suggestions could not be loaded. You can still enter an email address.</small>}
      <label className="field"><span>Subject</span><input value={title} disabled={busy || !allowed} onChange={event => setTitle(event.target.value)} /></label>
      <label className="field"><span>Template</span><select value={templateId} disabled={busy || !allowed || templateLoading || templateError} onChange={event => {
        const chosen = templates.find(template => template.id === event.target.value);
        if (chosen && body.trim() && !confirm("Replace your current subject and message with this template?")) return;
        setTemplateId(event.target.value);
        if (chosen) { setTitle(chosen.subject); setBody(chosen.body); setHtml(""); setVersion(value => value + 1); }
      }}><option value="">{templateLoading ? "Loading templates…" : "No template"}</option>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
      {templateError && <p role="status">Templates could not be loaded. You can still write your message. <button type="button" className="btn secondary compact" disabled={busy} onClick={() => setRetry(value => value + 1)}>Retry templates</button></p>}
      <RichMessageEditor text={body} version={version} disabled={busy || !allowed} onChange={(text, markup) => { dirty.current = true; setBody(text); setHtml(markup); }} />
      <div className="mail-compose-actions"><button type="button" className="btn secondary" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="btn primary" disabled={busy || !allowed || !body.trim() || !to.trim()}>{busy ? "Sending…" : "Send"}</button></div>
    </form>
  </Drawer></div>;
}
