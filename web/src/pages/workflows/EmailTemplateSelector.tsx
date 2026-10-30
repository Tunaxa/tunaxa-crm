import { useEffect, useId, useState } from "react";
import { api } from "../../lib/api";
import { parseEmailTemplates, templateParts, type EmailTemplate } from "./emailTemplates";

export function MergeTagText({ text }: { text: string }) {
  return <>{templateParts(text).map((part, index) => part.mergeTag ? <mark className="email-merge-tag" key={index}>{part.value}</mark> : <span key={index}>{part.value}</span>)}</>;
}
export function EmailTemplatePreview({ template }: { template: EmailTemplate }) {
  return <section className="workflow-template-preview" aria-label="Selected email template preview">
    <h4>{template.name}</h4><p><strong>Subject: </strong><MergeTagText text={template.subject} /></p>
    <div className="workflow-template-body"><MergeTagText text={template.body} /></div>
    <small>Highlighted merge tags are replaced with record values when the workflow runs.</small>
  </section>;
}
export function EmailTemplateSelector({ templateId, onSelect }: { templateId: string; onSelect: (template: EmailTemplate | null) => void }) {
  const id = useId(), [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(false); setTemplates([]);
    api<unknown>("/templates", { signal: controller.signal }).then(parseEmailTemplates)
      .then(rows => { if (!controller.signal.aborted) setTemplates(rows); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);
  const selected = templates.find(template => template.id === templateId);
  return <>
    <label className="field" htmlFor={id}><span>Email template</span><select id={id} value={templateId} disabled={loading || error} onChange={event => onSelect(templates.find(template => template.id === event.target.value) || null)}>
      <option value="">{loading ? "Loading templates…" : "No template"}</option>
      {templateId && !selected && <option value={templateId}>Unavailable template</option>}
      {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
    </select></label>
    {loading && <p role="status">Loading email templates…</p>}
    {error && <div role="alert"><p>Email templates could not be loaded.</p><button type="button" className="btn secondary compact" onClick={() => setRetry(value => value + 1)}>Retry templates</button></div>}
    {!loading && !error && !templates.length && <p>No email templates yet. Create one in Templates, then reopen this panel or refresh.</p>}
    {!loading && !error && templateId && !selected && <p role="alert">The saved template is no longer available. Choose another template.</p>}
    {selected && <EmailTemplatePreview template={selected} />}
  </>;
}
