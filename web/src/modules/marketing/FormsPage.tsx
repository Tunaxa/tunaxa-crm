import { useState } from "react";
import { useApp } from "../../context/AppContext";
import { useResource } from "../../lib/useResource";
import { api, json } from "../../lib/api";
import { SimpleCards } from "../../components/records/SimpleCards";
import { canManageRecords } from "../../components/records/rbac";
import {
  isSafeRedirectUrl,
  safeRedirectUrl,
  sanitizeFormFieldKey,
} from "../../components/records/urlSecurity";
import { Badge, Drawer, Toggle } from "../../components/ui";
import { Icon } from "../../components/Icon";
import type { Row } from "../../components/records/types";

export const formFieldTypes = [
  "text",
  "email",
  "phone",
  "number",
  "date",
  "textarea",
  "select",
  "checkbox",
  "MultiSelect",
] as const;

export type FormFieldDraft = {
  key: string;
  name: string;
  type: (typeof formFieldTypes)[number];
  required: boolean;
};

export function blankFormField(): FormFieldDraft {
  return { key: "", name: "", type: "text", required: false };
}

function stringOf(value: unknown, maxLength = 200): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function normalizeFormFields(value: unknown): FormFieldDraft[] {
  const input = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const fields: FormFieldDraft[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const key = sanitizeFormFieldKey(raw.key ?? raw.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const requestedType = stringOf(raw.type, 40);
    const type = formFieldTypes.includes(requestedType as FormFieldDraft["type"])
      ? (requestedType as FormFieldDraft["type"])
      : "text";
    fields.push({
      key,
      name: stringOf(raw.name ?? raw.label, 120) || key,
      type,
      required: Boolean(raw.required),
    });
  }
  return fields.length ? fields : [blankFormField()];
}

export function buildFormPayload(input: {
  name: string;
  title: string;
  description: string;
  submitTo: string;
  progressive: boolean;
  redirectUrl: string;
  enabled: boolean;
  fields: FormFieldDraft[];
}) {
  const redirectUrl = safeRedirectUrl(input.redirectUrl);
  if (input.redirectUrl.trim() && !isSafeRedirectUrl(input.redirectUrl)) {
    throw new Error("Redirect URL must be a same-origin or HTTPS address");
  }
  const fields = normalizeFormFields(input.fields).filter((field) => field.key);
  if (!fields.length) throw new Error("Add at least one form field");
  return {
    name: stringOf(input.name, 120),
    title: stringOf(input.title, 120),
    description: stringOf(input.description, 500),
    submitTo: input.submitTo === "contact" ? "contact" : "lead",
    progressive: Boolean(input.progressive),
    redirectUrl,
    enabled: Boolean(input.enabled),
    fields,
  };
}

export function FormsPage() {
  const { user, toast } = useApp();
  const canEdit = canManageRecords(user?.role);
  const [page, setPage] = useState(1);
  const { items: forms, loading, error, load, remove, total, limit } = useResource<Row>(
    "forms",
    { page, limit: 25 },
  );
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const publicBase = window.location.origin;

  return (
    <SimpleCards
      title="Forms"
      description="Capture leads and contacts with embeddable web forms."
      icon="form"
      items={forms}
      loading={loading}
      error={error}
      onRetry={() => load()}
      canAdd={canEdit}
      canEdit={canEdit}
      canDelete={canEdit}
      footer={
        totalPages > 1 || page > 1 ? (
          <nav className="table-pagination" aria-label="Forms pagination">
            <button
              type="button"
              className="btn secondary compact"
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous
            </button>
            <span>Page {page} of {Math.max(page, totalPages)}</span>
            <button
              type="button"
              className="btn secondary compact"
              disabled={page >= totalPages}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </button>
          </nav>
        ) : undefined
      }
      onAdd={() => setEdit(null)}
      onEdit={setEdit}
      onDelete={async (id) => {
        try {
          await remove(id);
          if (forms.length === 1 && page > 1) setPage((value) => value - 1);
        } catch (cause) {
          toast((cause as Error).message, "error");
        }
      }}
      render={(form) => {
        const fields = normalizeFormFields(form.fields).filter((field) => field.key);
        const permalink = encodeURIComponent(stringOf(form.permalink, 120));
        return (
          <>
            <div className="deal-top">
              <Badge tone={form.enabled ? "green" : "neutral"}>
                {form.enabled ? "Enabled" : "Disabled"}
              </Badge>
              <span className="table-count">{form.submissionCount || 0} submissions</span>
            </div>
            <h3>{stringOf(form.title || form.name, 120) || "Untitled form"}</h3>
            <p>{stringOf(form.description, 500) || "No description"}</p>
            <small>
              {permalink}
              {fields.length ? ` · ${fields.length} fields` : ""}
              {form.submitTo
                ? ` · ${form.submitTo === "contact" ? "Contacts" : "Leads"}`
                : ""}
            </small>
            {permalink ? (
              <button
                className="btn ghost compact"
                onClick={() =>
                  navigator.clipboard
                    .writeText(`${publicBase}/api/forms/${permalink}`)
                    .then(() => toast("Form URL copied"))
                    .catch(() => toast("Could not copy the form URL", "error"))
                }
              >
                <Icon name="copy" /> Copy URL
              </button>
            ) : null}
          </>
        );
      }}
      modal={
        edit !== undefined && canEdit ? (
          <FormEditor
            initial={edit || null}
            onClose={() => setEdit(undefined)}
            onSaved={() => {
              void load();
              setEdit(undefined);
            }}
          />
        ) : null
      }
    />
  );
}

export function FormEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: Row | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const [name, setName] = useState(initial?.name || "");
  const [title, setTitle] = useState(initial?.title || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [submitTo, setSubmitTo] = useState(initial?.submitTo || "lead");
  const [progressive, setProgressive] = useState(initial?.progressive !== false);
  const [redirectUrl, setRedirectUrl] = useState(initial?.redirectUrl || "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [fields, setFields] = useState<FormFieldDraft[]>(
    normalizeFormFields(initial?.fields),
  );
  const [busy, setBusy] = useState(false);

  function setField(index: number, patch: Partial<FormFieldDraft>) {
    setFields((current) =>
      current.map((field, position) =>
        position === index ? { ...field, ...patch } : field,
      ),
    );
  }

  async function save() {
    if (!stringOf(name)) return toast("Form name is required", "error");
    setBusy(true);
    try {
      const payload = buildFormPayload({
        name,
        title,
        description,
        submitTo,
        progressive,
        redirectUrl,
        enabled,
        fields,
      });
      if (initial?.id) await api(`/forms/${initial.id}`, json("PUT", payload));
      else await api("/forms", json("POST", payload));
      toast(initial?.id ? "Form updated" : "Form created");
      onSaved();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={initial?.id ? "Edit form" : "New form"}
      subtitle="Build an embeddable web form that captures leads or contacts."
      onClose={onClose}
      width={760}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : initial?.id ? "Save form" : "Create form"}
          </button>
        </>
      }
    >
      <div className="drawer-form">
        <label className="field">
          <span>Form name *</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Contact us form"
          />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>Public title</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Form title shown to visitors"
            />
          </label>
          <label className="field">
            <span>Save submissions to</span>
            <select value={submitTo} onChange={(event) => setSubmitTo(event.target.value)}>
              <option value="lead">Leads</option>
              <option value="contact">Contacts</option>
            </select>
          </label>
          <label className="field">
            <span>Redirect URL (after submit)</span>
            <input
              value={redirectUrl}
              onChange={(event) => setRedirectUrl(event.target.value)}
              placeholder="https://…"
            />
          </label>
          <label className="field">
            <span>Description</span>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Short description"
            />
          </label>
        </div>
        <div className="setting-toggle">
          <div>
            <b>Enable form</b>
            <p>Visitors can see and submit this form.</p>
          </div>
          <Toggle label="Enable form" value={enabled} onChange={setEnabled} />
        </div>
        <div className="setting-toggle">
          <div>
            <b>Progressive profiling</b>
            <p>Hide fields the visitor has already answered.</p>
          </div>
          <Toggle
            label="Progressive profiling"
            value={progressive}
            onChange={setProgressive}
          />
        </div>
        <h4>Form fields</h4>
        {fields.map((field, index) => (
          <div className="form-field-editor" key={`${index}-${field.key}`}>
            <label className="field">
              <span>Field label</span>
              <input
                value={field.name}
                onChange={(event) => setField(index, { name: event.target.value })}
                placeholder="e.g. Email address"
              />
            </label>
            <label className="field">
              <span>Field key</span>
              <input
                value={field.key}
                onChange={(event) => setField(index, { key: event.target.value })}
                placeholder="e.g. email"
              />
            </label>
            <label className="field">
              <span>Type</span>
              <select
                value={field.type}
                onChange={(event) =>
                  setField(index, {
                    type: event.target.value as FormFieldDraft["type"],
                  })
                }
              >
                {formFieldTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <div className="toggle-row">
              <input
                type="checkbox"
                aria-label={`${field.name || `Field ${index + 1}`} required`}
                checked={field.required}
                onChange={(event) => setField(index, { required: event.target.checked })}
              />
              <span>Required</span>
            </div>
            <button
              className="btn ghost compact danger-link"
              onClick={() =>
                setFields((current) => current.filter((_, position) => position !== index))
              }
              disabled={fields.length === 1}
            >
              <Icon name="trash" /> Remove
            </button>
          </div>
        ))}
        <button
          className="btn secondary compact"
          onClick={() => setFields((current) => [...current, blankFormField()])}
        >
          <Icon name="plus" /> Add field
        </button>
      </div>
    </Drawer>
  );
}
