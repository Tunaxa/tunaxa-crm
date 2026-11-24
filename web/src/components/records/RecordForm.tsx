import { type ReactNode, useState } from "react";
import { useApp } from "../../context/AppContext";
import { Drawer, PhotoField } from "../ui";
import { safeMediaSrc, sanitizeFieldKey, sanitizeFormValues } from "./urlSecurity";
import type { FieldSpec, Row } from "./types";

export function RecordForm({
  title,
  fields,
  initial,
  onClose,
  onSave,
  toolbar,
}: {
  title: string;
  fields: FieldSpec[];
  initial: Row | Record<string, unknown>;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  toolbar?: ReactNode;
}) {
  const { toast } = useApp();
  const safeFields = fields.filter((field) => Boolean(sanitizeFieldKey(field.key)));
  const [form, setForm] = useState<Record<string, unknown>>(() => {
    const values: Record<string, unknown> = {};
    for (const field of safeFields) {
      const key = sanitizeFieldKey(field.key);
      if (!key) continue;
      const source = initial as Record<string, unknown>;
      values[key] =
        source && Object.prototype.hasOwnProperty.call(source, key)
          ? source[key]
          : field.type === "select"
            ? field.options?.[0] ?? ""
            : field.type === "checkbox"
              ? false
              : "";
    }
    return values;
  });
  const [busy, setBusy] = useState(false);

  function patch(key: string, value: unknown) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    const missing = safeFields.find(
      (field) =>
        field.required &&
        !String(form[sanitizeFieldKey(field.key) ?? ""] ?? "").trim(),
    );
    if (missing) return toast(`${missing.label} is required`, "error");
    const payload = sanitizeFormValues(form, safeFields);
    if (!Object.keys(payload).length) return toast("No valid fields to save", "error");
    setBusy(true);
    try {
      await onSave(payload);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={title}
      subtitle="Changes are saved directly to your workspace."
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="drawer-form">
        {toolbar}
        {safeFields.map((field) => {
          const key = sanitizeFieldKey(field.key);
          if (!key) return null;
          if (field.type === "photo") {
            return (
              <PhotoField
                key={key}
                label={field.label}
                name={String(form.name ?? form.title ?? "")}
                value={safeMediaSrc(form[key])}
                onChange={(url: string) => patch(key, safeMediaSrc(url))}
              />
            );
          }
          if (field.type === "checkbox") {
            return (
              <label className="toggle-row" key={key}>
                <input
                  type="checkbox"
                  checked={Boolean(form[key])}
                  onChange={(event) => patch(key, event.target.checked)}
                />
                <span>{field.label}</span>
              </label>
            );
          }
          return (
            <label className="field" key={key}>
              <span>
                {field.label}
                {field.required ? <em className="required-mark">*</em> : null}
              </span>
              {field.type === "select" ? (
                <select
                  value={String(form[key] ?? "")}
                  onChange={(event) => patch(key, event.target.value)}
                >
                  {(field.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : field.type === "textarea" ? (
                <textarea
                  value={String(form[key] ?? "")}
                  onChange={(event) => patch(key, event.target.value)}
                  placeholder={field.placeholder}
                  rows={6}
                />
              ) : (
                <input
                  type={field.type === "number" ? "number" : field.type === "email" ? "email" : field.type === "date" ? "date" : "text"}
                  required={field.required}
                  value={String(form[key] ?? "")}
                  placeholder={field.placeholder}
                  onChange={(event) =>
                    patch(
                      key,
                      field.type === "number"
                        ? Number(event.target.value)
                        : event.target.value,
                    )
                  }
                />
              )}
            </label>
          );
        })}
      </div>
    </Drawer>
  );
}
