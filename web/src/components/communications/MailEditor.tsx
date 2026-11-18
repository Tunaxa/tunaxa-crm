import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  emailPayload,
  parseEmailTemplates,
  type EmailPayload,
  type EmailTemplate,
  type Message,
} from "./inboxModel";

function createIdempotencyKey() {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `email_${random}`;
}

export function MailEditor({
  recipient = "",
  subject = "",
  contact = "",
  reply = false,
  disabled = false,
  onSend,
  onSent,
  onBusy,
}: {
  recipient?: string;
  subject?: string;
  contact?: string;
  reply?: boolean;
  disabled?: boolean;
  onSend: (payload: EmailPayload) => Promise<Message>;
  onSent: (message: Message) => void;
  onBusy?: (value: boolean) => void;
}) {
  const recipientId = useId();
  const subjectId = useId();
  const templateId = useId();
  const bodyId = useId();

  const [to, setTo] = useState(recipient);
  const [title, setTitle] = useState(subject);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [templateError, setTemplateError] = useState(false);
  const [templateLoading, setTemplateLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const operation = useRef(false);
  const attempt = useRef({ fingerprint: "", key: "" });

  useEffect(() => {
    const abort = new AbortController();
    setTemplateLoading(true);
    setTemplateError(false);
    api<unknown>("/templates?limit=100", { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setTemplates(parseEmailTemplates(value));
      })
      .catch(() => {
        if (!abort.signal.aborted) setTemplateError(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setTemplateLoading(false);
      });
    return () => abort.abort();
  }, [retry]);

  async function send() {
    if (operation.current || disabled) return;
    setError("");
    let payload: EmailPayload;
    try {
      const fingerprint = JSON.stringify([
        reply ? recipient : to,
        reply ? subject : title,
        body.trim(),
        contact,
      ]);
      if (attempt.current.fingerprint !== fingerprint) {
        attempt.current = { fingerprint, key: createIdempotencyKey() };
      }
      payload = emailPayload(
        reply ? recipient : to,
        reply ? subject : title,
        body,
        attempt.current.key,
        contact,
      );
    } catch (failure) {
      setError((failure as Error).message);
      return;
    }

    operation.current = true;
    setBusy(true);
    onBusy?.(true);
    try {
      const saved = await onSend(payload);
      setBody("");
      setSelectedTemplate("");
      attempt.current = { fingerprint: "", key: "" };
      onSent(saved);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      operation.current = false;
      setBusy(false);
      onBusy?.(false);
    }
  }

  return (
    <form
      className="inbox-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {error ? (
        <p role="alert" aria-live="assertive">
          {error}
        </p>
      ) : null}
      {reply ? (
        <p className="inbox-reply-address">
          To: <strong>{recipient}</strong> · {subject}
        </p>
      ) : (
        <>
          <label htmlFor={recipientId}>
            <span>Recipient *</span>
            <input
              id={recipientId}
              type="email"
              required
              value={to}
              disabled={busy || disabled}
              autoComplete="email"
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <label htmlFor={subjectId}>
            <span>Subject</span>
            <input
              id={subjectId}
              value={title}
              disabled={busy || disabled}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        </>
      )}
      <label htmlFor={templateId}>
        <span>Email template</span>
        <select
          id={templateId}
          value={selectedTemplate}
          disabled={
            busy ||
            disabled ||
            templateLoading ||
            templateError ||
            templates.length === 0
          }
          onChange={(event) => {
            setSelectedTemplate(event.target.value);
            const template = templates.find((row) => row.id === event.target.value);
            if (template) {
              setBody(template.body);
              if (!reply) setTitle(template.subject);
            }
          }}
        >
          <option value="">
            {templateLoading ? "Loading templates…" : "No template"}
          </option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
      </label>
      {templateError ? (
        <p role="status">
          Templates could not be loaded. You can still write your message.{" "}
          <button
            type="button"
            className="btn secondary compact"
            disabled={busy || disabled}
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry templates
          </button>
        </p>
      ) : null}
      {!templateLoading && !templateError && templates.length === 0 ? (
        <p role="status">No templates available</p>
      ) : null}
      <label htmlFor={bodyId}>
        <span>Message *</span>
        <textarea
          id={bodyId}
          required
          rows={reply ? 4 : 7}
          value={body}
          disabled={busy || disabled}
          onChange={(event) => setBody(event.target.value)}
          placeholder={reply ? "Write your reply…" : "Write your email…"}
        />
      </label>
      <button
        type="submit"
        className="btn primary"
        disabled={
          busy || disabled || !body.trim() || !(reply ? recipient : to).trim()
        }
      >
        {busy ? "Sending…" : reply ? "Send reply" : "Send email"}
      </button>
    </form>
  );
}
