import { Drawer } from "../../components/ui";
import { EmailTemplateSelector } from "./EmailTemplateSelector";
import { isSendEmail, type EmailTemplate } from "./emailTemplates";

type Props = {
  actionType: string;
  templateId: string;
  onSelect: (template: EmailTemplate | null) => void;
  onClose: () => void;
  readOnly?: boolean;
};

export function ActionConfigPanel({
  actionType,
  templateId,
  onSelect,
  onClose,
  readOnly = false,
}: Props) {
  const email = isSendEmail(actionType);

  return (
    <Drawer title="Action configuration" onClose={onClose} width={360}>
      <p>
        <strong>{email ? "Send Email" : actionType || "Action"}</strong>
      </p>
      {email ? (
        <EmailTemplateSelector
          templateId={templateId}
          onSelect={onSelect}
          disabled={readOnly}
        />
      ) : (
        <p>Select or drag a Send Email action to preview an email template.</p>
      )}
    </Drawer>
  );
}
