import { type FieldSpec, type Row, type BadgeTone } from "../../components/records/types";
import { useState, useRef, useEffect } from "react";
import { type FilterGroup, FilterBuilder } from "../../components/FilterBuilder";
import { useResource } from "../../lib/useResource";
import { useApp } from "../../context/AppContext";
import { useNavigate } from "react-router-dom";
import { getPageSize, savePageSize } from "../../components/records/preferences";
import { useSchema } from "../../components/records/useSchema";
import { useBulkSelection, SelectPage, BulkActions } from "../../components/BulkActions";
import { api, json } from "../../lib/api";
import { downloadResourceCsv } from "../../components/records/downloadResourceCsv";
import { showMoney } from "../../components/records/formatters";
import { money, PageHeader, Avatar, Badge, Empty } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { RecordForm } from "../../components/records/RecordForm";

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
  const [pageSize, setPageSize] = useState(getPageSize());
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const custom = useSchema(resource);
  const allFields = [
    ...fields,
    ...custom.filter((field) => !fields.some((base) => base.key === field.key)),
  ];

  const cols = allFields;
  const mCols = new Set(cols.map((field) => field.key));
  const singular = title.slice(0, -1).toLowerCase();
  const nameOf = (row: Row) => String(row.name || row.title || "Untitled");
  const synopsis = (row: Row) => row.company || row.role || "";
  const statusField = "status";
  const toneOf = (value?: string): BadgeTone => value === "Active" ? "green" : "blue";
const filteredRows = items.filter(
  (row) =>
    !query ||
    JSON.stringify(row).toLowerCase().includes(query.toLowerCase()),
);

const rows = filteredRows.slice(
  (page - 1) * pageSize,
  page * pageSize,
);

useEffect(() => {
  setPage(1);
}, [query, pageSize, resource, filters]);

function changePageSize(value: number) {
  setPageSize(value);
  setPage(1);
  savePageSize(value);
}
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
    try {
      await downloadResourceCsv(resource);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  function cell(row: Row, field: FieldSpec) {
    const value = row[field.key];
    if (value === undefined || value === null || value === "") return "—";
    if (showMoney(field.key) && mCols.has(field.key))
      return money(Number(value));
    if (field.type === "date") return String(value).slice(0, 10);
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
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
        <button className="btn secondary" onClick={exportCsv}>
          <Icon name="download" /> Export CSV
        </button>
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Icon name="plus" /> Add {singular}
        </button>
      </PageHeader>
      <FilterBuilder fields={allFields} value={filters} onChange={(next) => { if (!bulk.busy) setFilters(next); }} />
      <section className="surface table-surface">
        <div className="table-toolbar">
          <div className="header-search">
            <Icon name="search" />
            <input
              aria-label={`Search ${title.toLowerCase()}`}
              value={query}
              disabled={bulk.busy} onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${title.toLowerCase()}`}
            />
          </div>
<span className="table-count">
  {filteredRows.length} total
</span>

<select
  value={pageSize}
  onChange={(e) => changePageSize(Number(e.target.value))}
  className="table-page-size"
  aria-label="Rows per page"
>
  <option value={10}>10</option>
  <option value={25}>25</option>
  <option value={50}>50</option>
  <option value={100}>100</option>
</select>        </div>
        {loading ? (
          <div className="table-loading" role="status">Loading…</div>
        ) : error ? (
          <Empty icon={icon} title={`Could not load ${title.toLowerCase()}`} text={error}
            action={<button type="button" className="btn secondary" onClick={() => load()}>Retry</button>} />
        ) : rows.length ? (
          <table>
            <thead>
              <tr>
                {canBulk && <th><SelectPage ids={rows.map((row) => row.id)} selected={bulk.selected} onChange={bulk.setSelected} disabled={bulk.busy} /></th>}
                <th>{cols[0]?.label || "Name"}</th>
                {cols.slice(1).map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {canBulk && <td><input className="bulk-select" type="checkbox" aria-label={`Select ${row.name || row.title || row.id}`} checked={bulk.selected.includes(row.id)} disabled={bulk.busy || (!bulk.selected.includes(row.id) && bulk.selected.length >= 100)} onChange={() => bulk.toggle(row.id)} /></td>}
                  {cols.map((c, i) =>
                    i === 0 ? (
                      <td key={c.key}>
                        <button
                          className="person-cell person-link"
                          onClick={() => navigate(`/${resource}/${row.id}`)}
                        >
                          <Avatar
                            name={nameOf(row)}
                            src={row.avatar || row.logo}
                          />
                          <div>
                            <b>{nameOf(row)}</b>
                            {synopsis ? <small>{synopsis(row)}</small> : null}
                          </div>
                        </button>
                      </td>
                    ) : c.key === statusField ? (
                      <td key={c.key}>
                        <Badge tone={toneOf(row[statusField!])}>
                          {row[statusField!] || "—"}
                        </Badge>
                      </td>
                    ) : (
                      <td key={c.key}>{cell(row, c)}</td>
                    ),
                  )}
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
                          confirm(`Delete ${nameOf(row)}?`) && remove(row.id)
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
                : `Add your first ${singular} or import a CSV file.`
            }
            action={
              !query ? (
                <button
                  className="btn primary compact"
                  onClick={() => setEdit(null)}
                >
                  Add {singular}
                </button>
              ) : undefined
            }
          />
        )}
      </section>
      {canBulk && <BulkActions resource={resource} ids={bulk.selected} statuses={allFields.find((field) => field.key === "status")?.options} busy={bulk.busy} setBusy={bulk.setBusy} onSelection={bulk.setSelected} onReload={load} />}
      {edit !== undefined ? (
        <RecordForm
          title={`${edit ? "Edit" : "Add"} ${singular}`}
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
