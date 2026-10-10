import { useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api";
import { emailPayload, type EmailPayload, type Message } from "./inboxModel";

type Template = { id: string; name: string; subject: string; body: string };
export function MailEditor({ recipient = "", subject = "", contact = "", reply = false, disabled = false, onSend, onSent, onBusy }: {
  recipient?: string; subject?: string; contact?: string; reply?: boolean; disabled?: boolean;
  onSend: (payload: EmailPayload) => Promise<Message>; onSent: (message: Message) => void; onBusy?: (value: boolean) => void;
}) {
  const [to, setTo] = useState(recipient), [title, setTitle] = useState(subject), [body, setBody] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [templates, setTemplates] = useState<Template[]>([]), [templateId, setTemplateId] = useState("");
  const [templateError, setTemplateError] = useState(false), [templateLoading, setTemplateLoading] = useState(true), [retry, setRetry] = useState(0);
  const operation = useRef(false), attempt = useRef({ fingerprint: "", key: "" });
  useEffect(() => {
    const abort = new AbortController(); setTemplateLoading(true); setTemplateError(false);
    api<unknown>("/templates", { signal: abort.signal }).then(value => {
      if (!Array.isArray(value)) throw new Error("Invalid templates response");
      const rows = value.filter(row => row && typeof row.id === "string" && (!row.channel || String(row.channel).toLowerCase() === "email"))
        .map(row => ({ id: row.id, name: String(row.name || "Untitled template"), subject: String(row.subject || ""), body: String(row.body || "") }));
      if (!abort.signal.aborted) setTemplates(rows);
    }).catch(() => { if (!abort.signal.aborted) setTemplateError(true); })
      .finally(() => { if (!abort.signal.aborted) setTemplateLoading(false); });
    return () => abort.abort();
  }, [retry]);

  async function send() {
    if (operation.current || disabled) return;
    setError("");
    let payload: EmailPayload;
    try {
      const fingerprint = JSON.stringify([reply ? recipient : to, reply ? subject : title, body.trim(), contact]);
      if (attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: `email_${crypto.randomUUID()}` };
      payload = emailPayload(reply ? recipient : to, reply ? subject : title, body, attempt.current.key, contact);
    } catch (failure) { setError((failure as Error).message); return; }
    operation.current = true; setBusy(true); onBusy?.(true);
    try { const saved = await onSend(payload); setBody(""); setTemplateId(""); attempt.current = { fingerprint: "", key: "" }; onSent(saved); }
    catch (failure) { setError((failure as Error).message); }
    finally { operation.current = false; setBusy(false); onBusy?.(false); }
  }
  return <form className="inbox-editor" onSubmit={event => { event.preventDefault(); void send(); }}>
    <h3>{reply ? "Reply inline" : "Compose email"}</h3>
    {error && <p role="alert">{error}</p>}
    {reply ? <p className="inbox-reply-address">To: <strong>{recipient}</strong> · {subject}</p> : <>
      <label className="field"><span>Recipient *</span><input type="email" required value={to} disabled={busy || disabled} autoComplete="email" onChange={event => setTo(event.target.value)} /></label>
      <label className="field"><span>Subject</span><input value={title} disabled={busy || disabled} onChange={event => setTitle(event.target.value)} /></label>
    </>}
    <label className="field"><span>Email template</span><select value={templateId} disabled={busy || disabled || templateLoading || templateError} onChange={event => {
      setTemplateId(event.target.value); const template = templates.find(row => row.id === event.target.value);
      if (template) { setBody(template.body); if (!reply) setTitle(template.subject); }
    }}><option value="">{templateLoading ? "Loading templates…" : "No template"}</option>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
    {templateError && <p role="status">Templates could not be loaded. You can still write your message. <button type="button" className="btn secondary compact" disabled={busy || disabled} onClick={() => setRetry(value => value + 1)}>Retry templates</button></p>}
    <label className="field"><span>Message *</span><textarea required rows={reply ? 4 : 7} value={body} disabled={busy || disabled} onChange={event => setBody(event.target.value)} placeholder={reply ? "Write your reply…" : "Write your email…"} /></label>
    <button type="submit" className="btn primary" disabled={busy || disabled || !body.trim() || !(reply ? recipient : to).trim()}>{busy ? "Sending…" : reply ? "Send reply" : "Send email"}</button>
  </form>;
}
