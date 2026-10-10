import { useApp } from "../../context/AppContext";
import { useState } from "react";
import { useResource } from "../../lib/useResource";
import { type Row } from "../../components/records/types";
import { api, json } from "../../lib/api";
import { SimpleCards } from "../../components/records/SimpleCards";
import { Badge, Drawer, Toggle } from "../../components/ui";
import { Icon } from "../../components/Icon";

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
];

export const blankFormField = () => ({
  key: "",
  name: "",
  type: "text",
  required: false,
});

export function FormsPage() {
  const { toast } = useApp();
  const [page, setPage] = useState(1);
  const { items: forms, loading, error, load, remove, total, limit } = useResource<Row>("forms", { page, limit: 25 });
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
      footer={totalPages > 1 || page > 1 ? <nav className="table-pagination" aria-label="Forms pagination">
        <button type="button" className="btn secondary compact" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button>
        <span>Page {page} of {Math.max(page, totalPages)}</span>
        <button type="button" className="btn secondary compact" disabled={page >= totalPages} onClick={() => setPage(value => value + 1)}>Next</button>
      </nav> : undefined}
      onAdd={() => setEdit(null)}
      onEdit={setEdit}
      onDelete={async (id) => {
        try {
          await remove(id);
          if (forms.length === 1 && page > 1) setPage(value => value - 1);
        } catch { /* useResource displays the deletion error. */ }
      }}
      render={(f) => (
        <>
          <div className="deal-top">
            <Badge tone={f.enabled ? "green" : "neutral"}>
              {f.enabled ? "Enabled" : "Disabled"}
            </Badge>
            <span className="table-count">
              {f.submissionCount || 0} submissions
            </span>
          </div>
          <h3>{f.title || f.name}</h3>
          <p>{f.description || "No description"}</p>
          <small>
            {f.permalink}
            {f.fields?.length ? ` · ${f.fields.length} fields` : ""}
            {f.submitTo
              ? ` · ${f.submitTo === "contact" ? "Contacts" : "Leads"}`
              : ""}
          </small>
          {f.permalink ? (
            <button
              className="btn ghost compact"
              onClick={() =>
                navigator.clipboard
                  .writeText(`${publicBase}/api/forms/${f.permalink}`)
                  .then(() => toast("Form URL copied"))
                  .catch(() => toast("Could not copy the form URL", "error"))
              }
            >
              <Icon name="copy" /> Copy URL
            </button>
          ) : null}
        </>
      )}
      modal={
        edit !== undefined ? (
          <FormEditor
            initial={edit || null}
            onClose={() => setEdit(undefined)}
            onSaved={() => {
              load();
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
  const [progressive, setProgressive] = useState(
    initial?.progressive !== false,
  );
  const [redirectUrl, setRedirectUrl] = useState(initial?.redirectUrl || "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [fields, setFields] = useState<Record<string, any>[]>(
    initial?.fields?.length
      ? (initial.fields as any[]).map((f) => ({
          key: f.key || "",
          name: f.name || f.label || "",
          type: f.type || "text",
          required: Boolean(f.required),
        }))
      : [blankFormField()],
  );
  const [busy, setBusy] = useState(false);
  function setField(index: number, patch: Record<string, any>) {
    setFields((current) =>
      current.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    );
  }
  async function save() {
    if (!String(name).trim()) return toast("Form name is required", "error");
    const valid = fields.filter((f) => String(f.key || "").trim());
    if (!valid.length) return toast("Add at least one form field", "error");
    const payload = {
      name: name.trim(),
      title: title.trim(),
      description: description.trim(),
      submitTo,
      progressive,
      redirectUrl: redirectUrl.trim(),
      enabled,
      fields: valid.map((f) => ({
        key: f.key.trim(),
        name: f.name || f.key.trim(),
        type: f.type || "text",
        required: Boolean(f.required),
      })),
    };
    setBusy(true);
    try {
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
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Contact us form"
          />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>Public title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Form title shown to visitors"
            />
          </label>
          <label className="field">
            <span>Save submissions to</span>
            <select
              value={submitTo}
              onChange={(e) => setSubmitTo(e.target.value)}
            >
              <option value="lead">Leads</option>
              <option value="contact">Contacts</option>
            </select>
          </label>
          <label className="field">
            <span>Redirect URL (after submit)</span>
            <input
              value={redirectUrl}
              onChange={(e) => setRedirectUrl(e.target.value)}
              placeholder="https://…"
            />
          </label>
          <label className="field">
            <span>Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
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
        {fields.map((field, i) => (
          <div className="form-field-editor" key={i}>
            <label className="field">
              <span>Field label</span>
              <input
                value={field.name}
                onChange={(e) => setField(i, { name: e.target.value })}
                placeholder="e.g. Email address"
              />
            </label>
            <label className="field">
              <span>Field key</span>
              <input
                value={field.key}
                onChange={(e) => setField(i, { key: e.target.value })}
                placeholder="e.g. email"
              />
            </label>
            <label className="field">
              <span>Type</span>
              <select
                value={field.type}
                onChange={(e) => setField(i, { type: e.target.value })}
              >
                {formFieldTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <div className="toggle-row">
              <input
                type="checkbox"
                aria-label={`${field.name || `Field ${i + 1}`} required`}
                checked={Boolean(field.required)}
                onChange={(e) => setField(i, { required: e.target.checked })}
              />
              <span>Required</span>
            </div>
            <button
              className="btn ghost compact danger-link"
              onClick={() =>
                setFields((current) => current.filter((_, j) => j !== i))
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
