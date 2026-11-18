import { useEffect, useRef, useState } from "react";
import { Drawer } from "../ui";
import { useApp } from "../../context/AppContext";
import { api, json } from "../../lib/api";
import { MailEditor } from "./MailEditor";
import {
  canSendEmail,
  deliveryLabel,
  type EmailPayload,
  type Message,
} from "./inboxModel";
import { sendRecordEmail } from "./sendRecordEmail";

export function EmailComposerDrawer({
  recipient,
  contact,
  entity = "contact",
  recordId,
  onClose,
  onSent,
}: {
  recipient: string;
  contact: string;
  entity?: "contact" | "lead";
  recordId?: string;
  onClose: () => void;
  onSent: (message: Message) => void;
}) {
  const { user, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const dirty = useRef(false);
  const mounted = useRef(true);
  const allowed = canSendEmail(user?.role);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function close() {
    if (sending.current) return;
    if (dirty.current && !window.confirm("Discard this email draft?")) return;
    onClose();
  }

  async function send(payload: EmailPayload) {
    if (!allowed) throw new Error("You do not have permission to send emails.");
    const record = recordId
      ? { recordId, entityType: entity, entityId: recordId }
      : undefined;
    return sendRecordEmail(
      payload,
      (value) => api("/messages/send", json("POST", value)),
      {
        record,
        logActivity: (activity) => api("/activities", json("POST", activity)),
      },
    );
  }

  return (
    <Drawer
      title="Compose email"
      subtitle={contact ? `Email ${contact} · ${entity}` : `Send from this ${entity}`}
      onClose={close}
    >
      <p role="note" className="inbox-draft-note">
        Messages are sent as plain text. Rich formatting and attachments are not
        available yet.
      </p>
      {!allowed ? (
        <p role="alert">You have read-only email access.</p>
      ) : null}
      <div
        onChangeCapture={() => {
          dirty.current = true;
        }}
      >
        <MailEditor
          recipient={recipient}
          contact={contact}
          disabled={!allowed || busy}
          onSend={send}
          onBusy={(value) => {
            sending.current = value;
            if (mounted.current) setBusy(value);
          }}
          onSent={(message) => {
            dirty.current = false;
            if (!mounted.current) return;
            toast(deliveryLabel(message));
            onSent(message);
            onClose();
          }}
        />
      </div>
    </Drawer>
  );
}
