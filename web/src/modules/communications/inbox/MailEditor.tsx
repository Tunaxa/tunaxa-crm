import { useEffect, useId, useRef, useState } from "react";
import {
  hasOwn,
  sanitizeFieldKey,
} from "../../../components/records/urlSecurity";
import { api } from "../../../lib/api";
import {
  buildEmailPayload,
  type EmailPayload,
  type Message,
} from "./inboxModel";

type EmailTemplate = { id: string; name: string; subject: string; body: string };

const templateFields = Object.freeze([
  "id",
  "name",
  "subject",
  "body",
  "channel",
] as const);
const templateKeys = new Set<string>(templateFields);

function isPageNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function readTemplateText(
  row: Record<string, unknown>,
  key: string,
): string {
  const safeKey = sanitizeFieldKey(key, templateKeys);
  if (!safeKey || !hasOwn(row, safeKey)) return "";
  const value = row[safeKey];
  return typeof value === "string" ? value : "";
}

function parseTemplates(value: unknown): EmailTemplate[] {
  const envelope =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const rows = Array.isArray(value) ? value : envelope?.data;
  if (!Array.isArray(rows)) throw new Error("Invalid templates response");
  if (envelope) {
    for (const key of ["total", "page", "limit"]) {
      if (hasOwn(envelope, key) && !isPageNumber(envelope[key])) {
        throw new Error("Invalid templates response");
      }
    }
  }

  return rows
    .filter((row) => !!row && typeof row === "object" && !Array.isArray(row))
    .map((row) => row as Record<string, unknown>)
    .filter((row) => {
      const channel = readTemplateText(row, "channel");
      return (
        !!readTemplateText(row, "id") &&
        (!channel || channel.toLowerCase() === "email")
      );
    })
    .map((row) => {
      const fields = Object.create(null) as Record<string, string>;
      for (const key of templateFields) {
        fields[key] = readTemplateText(row, key);
      }
      return {
        id: fields.id,
        name: fields.name || "Untitled template",
        subject: fields.subject,
        body: fields.body,
      };
    });
}

function createIdempotencyKey(): string {
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
    api<unknown>("/templates", { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setTemplates(parseTemplates(value));
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
      const target = reply ? recipient : to;
      const titleValue = reply ? subject : title;
      const fingerprint = JSON.stringify([
        target,
        titleValue,
        body.trim(),
        contact,
      ]);
      if (attempt.current.fingerprint !== fingerprint) {
        attempt.current = { fingerprint, key: createIdempotencyKey() };
      }
      payload = buildEmailPayload(
        target,
        titleValue,
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
    <form className="inbox-editor" onSubmit={(event) => {
      event.preventDefault();
      void send();
    }}>
      <h3>{reply ? "Reply inline" : "Compose email"}</h3>
      {error && <p role="alert">{error}</p>}
      {reply ? (
        <p className="inbox-reply-address">
          To: <strong>{recipient}</strong> · {subject}
        </p>
      ) : (
        <>
          <label className="field" htmlFor={recipientId}>
            <span>Recipient *</span>
            <input
              id={recipientId}
              type="email"
              required
              maxLength={255}
              value={to}
              disabled={busy || disabled}
              autoComplete="email"
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <label className="field" htmlFor={subjectId}>
            <span>Subject</span>
            <input
              id={subjectId}
              maxLength={255}
              value={title}
              disabled={busy || disabled}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        </>
      )}
      <label className="field" htmlFor={templateId}>
        <span>Email template</span>
        <select
          id={templateId}
          value={selectedTemplate}
          disabled={busy || disabled || templateLoading || templateError}
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
      {templateError && (
        <p role="alert">
          Templates could not be loaded. You can still write your message.
          <button
            type="button"
            className="btn secondary compact"
            disabled={busy || disabled}
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry templates
          </button>
        </p>
      )}
      <label className="field" htmlFor={bodyId}>
        <span>Message *</span>
        <textarea
          id={bodyId}
          required
          rows={reply ? 4 : 7}
          maxLength={20000}
          value={body}
          disabled={busy || disabled}
          onChange={(event) => setBody(event.target.value)}
          placeholder={reply ? "Write your reply…" : "Write your email…"}
        />
      </label>
      {busy && <p role="status">Sending…</p>}
      <button
        type="submit"
        className="btn primary"
        disabled={
          busy ||
          disabled ||
          !body.trim() ||
          !(reply ? recipient : to).trim()
        }
      >
        {busy ? "Sending…" : reply ? "Send reply" : "Send email"}
      </button>
    </form>
  );
}
