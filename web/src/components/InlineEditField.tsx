import { useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { PhotoField } from "./ui";
import "./inlineEditField.css";

export type InlineFieldSpec = {
  key: string;
  label: string;
  type?: string;
  options?: string[];
  required?: boolean;
  placeholder?: string;
};

export function inlineFieldValue(draft: string | boolean, type?: string) {
  if (type === "checkbox") return Boolean(draft);
  if (type === "number") {
    if (draft === "") return null;
    const number = Number(draft);
    if (!Number.isFinite(number)) throw new Error("Enter a valid number");
    return number;
  }
  return draft;
}

export function InlineEditField({ field, value, displayValue, onSave, disabled = false }: {
  field: InlineFieldSpec;
  value: unknown;
  displayValue?: ReactNode;
  disabled?: boolean;
  onSave: (value: string | number | boolean | null) => Promise<void>;
}) {
  const inputId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const saving = useRef(false);
  const uploading = useRef(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [draft, setDraft] = useState<string | boolean>("");
  const [error, setError] = useState("");

  function start() {
    setDraft(field.type === "checkbox" ? Boolean(value) : String(value ?? ""));
    setError("");
    setEditing(true);
  }

  function close() {
    if (saving.current || uploading.current) return;
    setEditing(false);
    setError("");
    requestAnimationFrame(() => trigger.current?.focus());
  }

  async function save() {
    if (saving.current || uploading.current) return;
    if (field.required && (field.type === "checkbox" ? !draft : !String(draft).trim())) {
      setError(`${field.label} is required`);
      return;
    }
    try {
      const nextValue = inlineFieldValue(draft, field.type);
      saving.current = true;
      setBusy(true);
      setError("");
      await onSave(nextValue);
      saving.current = false;
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save changes");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  const empty = value === null || value === undefined || value === "";
  const shown = displayValue ?? (empty ? "Add value" : field.type === "checkbox" ? (value ? "Yes" : "No") : String(value));
  return (
    <div className="inline-edit-field">
      <button ref={trigger} type="button" className={`inline-edit-value${empty ? " is-empty" : ""}`}
        hidden={editing} disabled={disabled} aria-label={`Edit ${field.label}`} onClick={start}>
        <span>{shown}</span><span className="inline-edit-pencil" aria-hidden="true"><Icon name="edit" /></span>
      </button>
      {editing && (
        <form className="inline-edit-form" aria-busy={busy || uploadBusy}
          onSubmit={(event) => { event.preventDefault(); void save(); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing &&
              (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)) {
              event.preventDefault(); event.currentTarget.requestSubmit();
            }
          }}>
          {field.type !== "photo" && <label htmlFor={inputId} className="inline-edit-label">{field.label}</label>}
          {field.type === "photo" ? (
            <fieldset disabled={busy} className="inline-edit-photo"><PhotoField label={field.label} name={field.label} value={String(draft)}
              onChange={(url: string) => { if (!saving.current) setDraft(url); }}
              onBusyChange={(active) => { uploading.current = active; setUploadBusy(active); }}
              onError={(failure) => setError(failure instanceof Error ? failure.message : "Could not upload image")} /></fieldset>
          ) : field.type === "select" ? (
            <select id={inputId} autoFocus disabled={busy} required={field.required}
              value={String(draft)} onChange={(event) => setDraft(event.target.value)}
              aria-invalid={!!error} aria-describedby={error ? `${inputId}-error` : undefined}>
              <option value="">Choose a value</option>
              {Boolean(value) && !field.options?.includes(String(value)) && <option value={String(value)}>{String(value)}</option>}
              {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          ) : field.type === "textarea" ? (
            <textarea id={inputId} autoFocus disabled={busy} required={field.required} rows={3}
              value={String(draft)} placeholder={field.placeholder} onChange={(event) => setDraft(event.target.value)}
              aria-invalid={!!error} aria-describedby={error ? `${inputId}-error` : undefined} />
          ) : field.type === "checkbox" ? (
            <input id={inputId} type="checkbox" autoFocus disabled={busy} required={field.required}
              checked={Boolean(draft)} onChange={(event) => setDraft(event.target.checked)} />
          ) : (
            <input id={inputId} autoFocus disabled={busy} required={field.required}
              type={["number", "email", "url", "date", "tel"].includes(field.type || "") ? field.type : "text"}
              step={field.type === "number" ? "any" : undefined} value={String(draft)} placeholder={field.placeholder}
              onChange={(event) => setDraft(event.target.value)} aria-invalid={!!error}
              aria-describedby={error ? `${inputId}-error` : undefined} />
          )}
          {error && <span id={`${inputId}-error`} role="alert" className="inline-edit-error">{error}</span>}
          <div className="inline-edit-actions">
            <button type="submit" className="btn primary compact" disabled={busy || uploadBusy}>{busy ? "Saving…" : uploadBusy ? "Uploading…" : "Save"}</button>
            <button type="button" className="btn ghost compact" disabled={busy || uploadBusy} onClick={close}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
