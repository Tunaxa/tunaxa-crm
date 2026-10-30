import { EmailTemplateSelector } from "./EmailTemplateSelector";
import { isSendEmail, type EmailTemplate } from "./emailTemplates";

export function ActionConfigPanel({ actionType, templateId, onSelect, onClose }: {
  actionType: string; templateId: string; onSelect: (template: EmailTemplate | null) => void; onClose: () => void;
}) {
  return <aside className="workflow-action-config" aria-label="Action configuration">
    <header><h3>Action configuration</h3><button type="button" className="btn secondary compact" onClick={onClose}>Close</button></header>
    <p><strong>{isSendEmail(actionType) ? "Send Email" : actionType || "Action"}</strong></p>
    {isSendEmail(actionType) ? <EmailTemplateSelector templateId={templateId} onSelect={onSelect} /> : <p>Select or drag a Send Email action to preview an email template.</p>}
  </aside>;
}
