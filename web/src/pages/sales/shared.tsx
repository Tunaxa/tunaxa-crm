import { BulkActions, SelectPage, useBulkSelection } from "../../components/BulkActions";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../../components/Icon";
import { Avatar, Badge, Drawer, Empty, PageHeader, PhotoField, money } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import { api, getToken, json } from "../../lib/api";
import { FilterBuilder, type FilterGroup } from "../../components/FilterBuilder";
import { useResource } from "../../lib/useResource";

type Row = { id: string; [key: string]: any };
export type FieldSpec = {
  key: string;
  label: string;
  type?: "text" | "number" | "email" | "date" | "select" | "textarea" | "checkbox" | "photo";
  options?: string[];
  required?: boolean;
  placeholder?: string;
};

const stages = [
  { id: "new", label: "New" },
  { id: "qualified", label: "Qualified" },
  { id: "proposal", label: "Proposal" },
  { id: "negotiation", label: "Negotiation" },
  { id: "won", label: "Won" },
];

async function downloadResourceCsv(resource: string) {
  const token = getToken();
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`/api/${resource}/export.csv`, { headers });
  if (!response.ok) throw new Error(`Export failed (${response.status})`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${resource}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function useSchema(object: string): FieldSpec[] {
  const [custom, setCustom] = useState<FieldSpec[]>([]);
  useEffect(() => {
    api<{ fields: FieldSpec[] }>(`/schema/${object}`)
      .then((schema) => setCustom(schema.fields))
      .catch(() => {});
  }, [object]);
  return custom;
}

function RecordForm({
  title,
  fields,
  initial,
  onClose,
  onSave,
  toolbar,
}: {
  title: string;
  fields: FieldSpec[];
  initial: Row | Record<string, any>;
  onClose: () => void;
  onSave: (data: Record<string, any>) => Promise<void>;
  toolbar?: ReactNode;
}) {
  const { toast } = useApp();
  const [form, setForm] = useState<Record<string, any>>(
    Object.fromEntries(
      fields.map((field) => [
        field.key,
        initial[field.key] ??
          (field.type === "select"
            ? field.options?.[0] || ""
            : field.type === "checkbox"
              ? false
              : ""),
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);

  async function save() {
    const missing = fields.find(
      (field) => field.required && !String(form[field.key] ?? "").trim(),
    );
    if (missing) return toast(`${missing.label} is required`, "error");
    setBusy(true);
    try {
      await onSave(form);
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
        {fields.map((field) =>
          field.type === "photo" ? (
            <PhotoField
              key={field.key}
              label={field.label}
              name={String(form.name || form.title || "")}
              value={form[field.key]}
              onChange={(url) =>
                setForm((current) => ({ ...current, [field.key]: url }))
              }
            />
          ) : field.type === "checkbox" ? (
            <label className="toggle-row" key={field.key}>
              <input
                type="checkbox"
                checked={Boolean(form[field.key])}
                onChange={(e) =>
                  setForm((current) => ({
                    ...current,
                    [field.key]: e.target.checked,
                  }))
                }
              />
              <span>{field.label}</span>
            </label>
          ) : (
            <label className="field" key={field.key}>
              <span>
                {field.label}
                {field.required ? <em className="required-mark">*</em> : null}
              </span>
              {field.type === "select" ? (
                <select
                  value={form[field.key]}
                  onChange={(e) =>
                    setForm((current) => ({
                      ...current,
                      [field.key]: e.target.value,
                    }))
                  }
                >
                  {field.options?.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : field.type === "textarea" ? (
                <textarea
                  value={form[field.key]}
                  onChange={(e) =>
                    setForm((current) => ({
                      ...current,
                      [field.key]: e.target.value,
                    }))
                  }
                  placeholder={field.placeholder}
                  rows={6}
                />
              ) : (
                <input
                  type={field.type || "text"}
                  required={field.required}
                  value={form[field.key]}
                  placeholder={field.placeholder}
                  onChange={(e) =>
                    setForm((current) => ({
                      ...current,
                      [field.key]:
                        field.type === "number"
                          ? Number(e.target.value)
                          : e.target.value,
                    }))
                  }
                />
              )}
            </label>
          ),
        )}
      </div>
    </Drawer>
  );
}

export function PeoplePage({
  resource,
  title,
  description,
  icon,
  fields,
}: {
  resource: string;
  title: string;
  description: string;
  icon: string;
  fields: FieldSpec[];
}) {
  const [filters, setFilters] = useState<FilterGroup | null>(null);
  const { items, loading, error, load, create, update, remove } =
    useResource<Row>(resource, { filters, all: true });
  const { toast, user } = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const custom = useSchema(resource);
  const allFields = [
    ...fields,
    ...custom.filter((field) => !fields.some((base) => base.key === field.key)),
  ];
  const peopleFields: FieldSpec[] = [
    { key: "avatar", label: "Photo", type: "photo" },
    ...allFields,
  ];
  const rows = items.filter(
    (row) =>
      !query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase()),
  );

  const bulk = useBulkSelection(JSON.stringify([resource, query, filters]), rows.map((row) => row.id));
  const canBulk = user?.role === "admin" || user?.role === "member";
  async function importCsv(file: File) {
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return toast("CSV has no rows", "error");
      const headers = lines[0]
        .split(",")
        .map((x) => x.trim().replace(/^"|"$/g, ""));
      const records = lines.slice(1).map((line) => {
        const values = line
          .split(",")
          .map((x) => x.trim().replace(/^"|"$/g, ""));
        return Object.fromEntries(
          headers.map((key, index) => [key, values[index] || ""]),
        );
      });
      await api(`/${resource}/batch`, json("POST", records));
      await load();
      toast(`${records.length} rows imported`);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function exportCsv() {
    if (!items.length) return toast("Nothing to export", "error");
    try {
      await downloadResourceCsv(resource);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  return (
    <div className="page">
      <PageHeader title={title} description={description}>
        <input
          ref={inputRef}
          hidden
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])}
        />
        <button
          className="btn secondary"
          onClick={() => inputRef.current?.click()}
        >
          <Icon name="upload" /> Import
        </button>
        <button
          className="btn secondary"
          disabled={!items.length}
          onClick={exportCsv}
        >
          <Icon name="download" /> Export
        </button>
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Icon name="plus" /> Add {title.slice(0, -1).toLowerCase()}
        </button>
      </PageHeader>
      <FilterBuilder fields={allFields} value={filters} onChange={(next) => { if (!bulk.busy) setFilters(next); }} />
      {error && <p role="alert">{error} <button type="button" onClick={() => load()}>Retry</button></p>}
      <section className="surface table-surface">
        <div className="table-toolbar">
          <div className="header-search">
            <Icon name="search" />
            <input
              value={query}
              disabled={bulk.busy} onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${title.toLowerCase()}`}
            />
          </div>
          <span className="table-count">{items.length} total</span>
        </div>
        {loading ? (
          <div className="table-loading">Loading…</div>
        ) : rows.length ? (
          <table>
            <thead>
              <tr>
                {canBulk && <th><SelectPage ids={rows.map((row) => row.id)} selected={bulk.selected} onChange={bulk.setSelected} disabled={bulk.busy} /></th>}
                <th>Name</th>
                <th>Company</th>
                <th>Email</th>
                <th>Phone</th>
                <th>{resource === "leads" ? "Status" : "Owner"}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {canBulk && <td><input className="bulk-select" type="checkbox" aria-label={`Select ${row.name || row.title || row.id}`} checked={bulk.selected.includes(row.id)} disabled={bulk.busy || (!bulk.selected.includes(row.id) && bulk.selected.length >= 100)} onChange={() => bulk.toggle(row.id)} /></td>}
                  <td>
                    <button
                      className="person-cell person-link"
                      onClick={() => navigate(`/${resource}/${row.id}`)}
                    >
                      <Avatar name={row.name || "NX"} src={row.avatar} />
                      <div>
                        <b>{row.name || "Untitled"}</b>
                        <small>{row.role || row.source || "—"}</small>
                      </div>
                    </button>
                  </td>
                  <td>{row.company || "—"}</td>
                  <td>{row.email || "—"}</td>
                  <td>{row.phone || "—"}</td>
                  <td>
                    {resource === "leads" ? (
                      <Badge
                        tone={
                          row.status === "Qualified"
                            ? "green"
                            : row.status === "Lost"
                              ? "red"
                              : "blue"
                        }
                      >
                        {row.status || "New"}
                      </Badge>
                    ) : (
                      row.owner || "—"
                    )}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="icon-btn tiny"
                        onClick={() => setEdit(row)}
                        title="Edit"
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        className="icon-btn tiny danger-link"
                        onClick={() =>
                          confirm(`Delete ${row.name || "record"}?`) &&
                          remove(row.id)
                        }
                        title="Delete"
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={icon}
            title={
              query
                ? `No ${title.toLowerCase()} found`
                : `No ${title.toLowerCase()} yet`
            }
            text={
              query
                ? "Try another search term."
                : `Add your first ${title.slice(0, -1).toLowerCase()} or import a CSV file.`
            }
            action={
              !query ? (
                <button
                  className="btn primary compact"
                  onClick={() => setEdit(null)}
                >
                  Add {title.slice(0, -1).toLowerCase()}
                </button>
              ) : undefined
            }
          />
        )}
      </section>
      {canBulk && <BulkActions resource={resource} ids={bulk.selected} statuses={allFields.find((field) => field.key === "status")?.options} busy={bulk.busy} setBusy={bulk.setBusy} onSelection={bulk.setSelected} onReload={load} />}
      {edit !== undefined ? (
        <RecordForm
          title={`${edit ? "Edit" : "Add"} ${title.slice(0, -1)}`}
          fields={peopleFields}
          initial={edit || {}}
          onClose={() => setEdit(undefined)}
          onSave={async (data) => {
            edit ? await update(edit.id, data) : await create(data);
            setEdit(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

export function CompaniesPage() {
  const fields: FieldSpec[] = [
    { key: "logo", label: "Logo", type: "photo" },
    { key: "name", label: "Company name" },
    { key: "industry", label: "Industry" },
    { key: "website", label: "Website" },
    { key: "country", label: "Country" },
    { key: "employees", label: "Employees", type: "number" },
    { key: "owner", label: "Owner" },
  ];
  const [filters, setFilters] = useState<FilterGroup | null>(null);
  const { items, loading, error, load, create, update, remove } = useResource<Row>("companies", { filters, all: true });
  const { toast, user } = useApp();
  const navigate = useNavigate();
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const custom = useSchema("companies");
  const nonPhoto = fields.filter((f) => f.key !== "logo");
  const photoField = fields.find((f) => f.key === "logo")!;
  const allFields = [
    photoField,
    ...nonPhoto,
    ...custom.filter((field) => !fields.some((base) => base.key === field.key)),
  ];
  const bulk = useBulkSelection(JSON.stringify(["companies", filters]), items.map((row) => row.id));
  const canBulk = user?.role === "admin" || user?.role === "member";
  async function exportCsv() {
    if (!items.length) return;
    try {
      await downloadResourceCsv("companies");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }
  return (
    <div className="page">
      <PageHeader
        title="Companies"
        description="Accounts, organizations and relationship ownership."
      >
        <button
          className="btn secondary"
          disabled={!items.length}
          onClick={exportCsv}
        >
          <Icon name="download" /> Export
        </button>
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Icon name="plus" /> Add company
        </button>
      </PageHeader>
      <FilterBuilder fields={allFields} value={filters} onChange={(next) => { if (!bulk.busy) setFilters(next); }} />
      {error && <p role="alert">{error} <button type="button" onClick={() => load()}>Retry</button></p>}
      {canBulk && <label><SelectPage ids={items.map((row) => row.id)} selected={bulk.selected} onChange={bulk.setSelected} disabled={bulk.busy || loading} /> Select visible companies (maximum 100)</label>}
      {loading ? <div role="status">Loading…</div> : items.length ? (
        <div className="company-grid">
          {items.map((company) => (
            <article
              className="company-card"
              key={company.id}
              onClick={() => navigate(`/companies/${company.id}`)}
              style={{ cursor: "pointer" }}
            >
              {canBulk && <label onClick={(event) => event.stopPropagation()}><input className="bulk-select" type="checkbox" aria-label={`Select ${company.name || company.id}`} checked={bulk.selected.includes(company.id)} disabled={bulk.busy || (!bulk.selected.includes(company.id) && bulk.selected.length >= 100)} onChange={() => bulk.toggle(company.id)} /> Select</label>}
              <header>
                <span className="company-logo">
                  {company.logo ? (
                    <img src={company.logo} alt="" />
                  ) : (
                    String(company.name || "NX")
                      .split(/\s+/)
                      .map((x: string) => x[0])
                      .join("")
                      .slice(0, 2)
                      .toUpperCase()
                  )}
                </span>
                <div
                  className="row-actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="icon-btn tiny"
                    onClick={() => setEdit(company)}
                  >
                    <Icon name="edit" />
                  </button>
                  <button
                    className="icon-btn tiny danger-link"
                    onClick={() =>
                      confirm("Delete this company?") && remove(company.id)
                    }
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </header>
              <h3>{company.name || "Untitled company"}</h3>
              <p>
                {company.industry || "No industry"}
                {company.country ? ` · ${company.country}` : ""}
              </p>
              <div className="company-meta">
                <span>
                  <small>Employees</small>
                  <b>{company.employees || 0}</b>
                </span>
                <span>
                  <small>Owner</small>
                  <b>{company.owner || "—"}</b>
                </span>
              </div>
              <footer>
                <Badge>{company.website || "No website"}</Badge>
                <span className="link-btn">Open account</span>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon="companies"
          title="No companies"
          text="Add companies to connect contacts and deals to accounts."
          action={
            <button
              className="btn primary compact"
              onClick={() => setEdit(null)}
            >
              Add company
            </button>
          }
        />
      )}
      {canBulk && <BulkActions resource="companies" ids={bulk.selected} busy={bulk.busy} setBusy={bulk.setBusy} onSelection={bulk.setSelected} onReload={load} />}
      {edit !== undefined ? (
        <RecordForm
          title={`${edit ? "Edit" : "Add"} company`}
          fields={allFields}
          initial={edit || {}}
          onClose={() => setEdit(undefined)}
          onSave={async (data) => {
            edit ? await update(edit.id, data) : await create(data);
            setEdit(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

export function PipelinePage() {
  const { items, create, update, remove } = useResource<Row>("deals");
  const navigate = useNavigate();
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const [dragging, setDragging] = useState<string | null>(null);
  const custom = useSchema("deals");
  const fields: FieldSpec[] = [
    { key: "title", label: "Deal name" },
    { key: "company", label: "Company" },
    { key: "value", label: "Value", type: "number" },
    {
      key: "stage",
      label: "Stage",
      type: "select",
      options: stages.map((x) => x.id),
    },
    { key: "owner", label: "Owner" },
    { key: "closeDate", label: "Close date", type: "date" },
  ];
  const allFields = [
    ...fields,
    ...custom.filter((field) => !fields.some((base) => base.key === field.key)),
  ];
  async function drop(stage: string) {
    if (!dragging) return;
    await update(dragging, { stage });
    setDragging(null);
  }
  return (
    <div className="page pipeline-page">
      <PageHeader
        title="Pipeline"
        description="Drag deals between stages and keep your pipeline moving."
      >
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Icon name="plus" /> Add deal
        </button>
      </PageHeader>
      {items.length ? (
        <div className="pipeline-board">
          {stages.map((stage) => {
            const rows = items.filter(
              (item) => (item.stage || "new") === stage.id,
            );
            return (
              <section
                className="pipeline-column"
                key={stage.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => drop(stage.id)}
              >
                <header>
                  <div>
                    <span className="dot" />
                    <b>{stage.label}</b>
                    <em>{rows.length}</em>
                  </div>
                  <strong>
                    {money(
                      rows.reduce(
                        (sum, row) => sum + Number(row.value || 0),
                        0,
                      ),
                    )}
                  </strong>
                </header>
                <div className="deal-list">
                  {rows.map((row) => (
                    <article
                      className="deal-card"
                      key={row.id}
                      draggable
                      onDragStart={() => setDragging(row.id)}
                    >
                      <div className="deal-top">
                        <Badge tone={stage.id === "won" ? "green" : "blue"}>
                          {stage.label}
                        </Badge>
                        <div className="row-actions">
                          <button
                            className="icon-btn tiny"
                            onClick={() => setEdit(row)}
                          >
                            <Icon name="edit" />
                          </button>
                          <button
                            className="icon-btn tiny danger-link"
                            onClick={() =>
                              confirm("Delete this deal?") && remove(row.id)
                            }
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                      </div>
                      <button
                        className="deal-title"
                        onClick={() => navigate(`/deals/${row.id}`)}
                      >
                        {row.title || "Untitled deal"}
                      </button>
                      <p>{row.company || "No company"}</p>
                      <strong>{money(row.value || 0)}</strong>
                      <footer>
                        <span>{row.owner || "Unassigned"}</span>
                        <small>{row.closeDate || "No close date"}</small>
                      </footer>
                    </article>
                  ))}
                  <button
                    className="add-deal"
                    onClick={() => setEdit({ id: "", stage: stage.id })}
                  >
                    <Icon name="plus" /> Add deal
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <Empty
          icon="pipeline"
          title="No deals"
          text="Add your first deal to start building the sales pipeline."
          action={
            <button
              className="btn primary compact"
              onClick={() => setEdit(null)}
            >
              Add deal
            </button>
          }
        />
      )}
      {edit !== undefined ? (
        <RecordForm
          title={`${edit?.id ? "Edit" : "Add"} deal`}
          fields={allFields}
          initial={edit || { stage: "new" }}
          onClose={() => setEdit(undefined)}
          onSave={async (data) => {
            edit?.id ? await update(edit.id, data) : await create(data);
            setEdit(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
