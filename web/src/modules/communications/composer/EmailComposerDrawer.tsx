import { useEffect, useRef, useState } from "react";
import { Drawer } from "../../../components/ui";
import { useApp } from "../../../context/AppContext";
import { api, json } from "../../../lib/api";
import { MailEditor } from "../inbox/MailEditor";
import { canSendEmail, deliveryLabel, type EmailPayload, type Message } from "../inbox/inboxModel";
import { sendRecordEmail } from "./sendRecordEmail";
import "../inbox/inbox.css";

export function EmailComposerDrawer({ recipient, contact, onClose, onSent }: {
  recipient: string; contact: string; onClose: () => void; onSent: (message: Message) => void;
}) {
  const { user, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const sending = useRef(false), dirty = useRef(false), mounted = useRef(true);
  const allowed = canSendEmail(user?.role);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function close() {
    if (sending.current) return;
    if (dirty.current && !confirm("Discard this email draft?")) return;
    onClose();
  }
  async function send(payload: EmailPayload) {
    if (!allowed) throw new Error("You do not have permission to send emails.");
    return sendRecordEmail(payload, value => api("/messages/send", json("POST", value)));
  }
  return <Drawer title="Compose email" subtitle={contact ? `Email ${contact}` : "Send from this record"} onClose={close}>
    <p role="note">Messages are sent as plain text. Rich formatting and attachments are not available yet.</p>
    {!allowed && <p role="alert">You have read-only email access.</p>}
    <div onChangeCapture={() => { dirty.current = true; }}>
      <MailEditor recipient={recipient} contact={contact} disabled={!allowed || busy} onSend={send}
        onBusy={value => { sending.current = value; if (mounted.current) setBusy(value); }}
        onSent={message => {
          dirty.current = false;
          if (!mounted.current) return;
          toast(deliveryLabel(message)); onSent(message); onClose();
        }} />
    </div>
  </Drawer>;
}
