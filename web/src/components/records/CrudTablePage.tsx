import { type FieldSpec, type Row, type BadgeTone } from "./types";
import { type ReactNode, useState, useRef, useEffect } from "react";
import { useResource } from "../../lib/useResource";
import { useApp } from "../../context/AppContext";
import { useNavigate } from "react-router-dom";
import { getPageSize, savePageSize } from "./preferences";
import { api, json } from "../../lib/api";
import { showMoney } from "./formatters";
import { money, PageHeader, Avatar, Badge, Empty } from "../ui";
import { Icon } from "../Icon";
import { RecordForm } from "./RecordForm";

export function CrudTablePage({
  resource,
  title,
  description,
  icon,
  fields,
  columns,
  nameKey = "name",
  statusField,
  synopsis,
  primary,
  statusTone,
  moneyColumn,
  extraColumn,
  renderEditor,
}: {
  resource: string;
  title: string;
  description: string;
  icon: string;
  fields: FieldSpec[];
  columns?: FieldSpec[];
  nameKey?: string;
  statusField?: string;
  synopsis?: (row: Row) => string;
  primary?: (row: Row) => string;
  statusTone?: (value?: string) => BadgeTone;
  moneyColumn?: string[];
  extraColumn?: { title: string; render: (row: Row) => ReactNode };
  renderEditor?: (props: {
    title: string;
    initial: Row | Record<string, any>;
    onClose: () => void;
    onSave: (data: Record<string, any>) => Promise<void>;
  }) => ReactNode;
}) {
  const { items, loading, error, load, create, update, remove } =
    useResource<Row>(resource, { all: true });
  const { toast } = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
const [pageSize, setPageSize] = useState(getPageSize());
const [page, setPage] = useState(1);
const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const cols = columns || fields;
  const mCols = new Set(moneyColumn || cols.map((c) => c.key));
  const singular = title.slice(0, -1).toLowerCase();
  const nameOf = (row: Row) =>
    primary ? primary(row) : String(row[nameKey] || "Untitled");
  const toneOf =
    statusTone ||
    ((value?: string): BadgeTone =>
      value === "Active" ||
      value === "Paid" ||
      value === "Approved" ||
      value === "Published" ||
      value === "Delivered" ||
      value === "Present" ||
      value === "Completed"
        ? "green"
        : value === "Lost" ||
            value === "Cancelled" ||
            value === "Rejected" ||
            value === "Absent" ||
            value === "Overdue" ||
            value === "Terminated"
          ? "red"
          : "blue");
const filteredRows = items.filter(
  (row) =>
    !query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase()),
);

const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));

const rows = filteredRows.slice(
  (page - 1) * pageSize,
  page * pageSize,
);
useEffect(() => {
  setPage(1);
}, [query, pageSize, resource]);

function changePageSize(value: number) {
  setPageSize(value);
  setPage(1);
  savePageSize(value);
}

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
  function exportCsv() {
    if (!items.length) return toast("Nothing to export", "error");
    const keys = fields.map((x) => x.key);
    const csv = [
      keys.join(","),
      ...items.map((row) =>
        keys
          .map((key) => `"${String(row[key] || "").replace(/"/g, '""')}"`)
          .join(","),
      ),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${resource}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
          onChange={(e) =>
            e.target.files?.[0] && importCsv(e.target.files[0])
          }
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

        <button
          className="btn primary"
          onClick={() => setEdit(null)}
        >
          <Icon name="plus" /> Add {singular}
        </button>
      </PageHeader>

      <section className="surface table-surface">
        <div className="table-toolbar">
          <div className="header-search">
            <Icon name="search" />

            <input
              aria-label={`Search ${title.toLowerCase()}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${title.toLowerCase()}`}
            />
          </div>

          <span className="table-count">
            {filteredRows.length} total
          </span>

          <select
            value={pageSize}
            onChange={(e) =>
              changePageSize(Number(e.target.value))
            }
            className="table-page-size"
            aria-label="Rows per page"
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>

        {loading ? (
          <div className="table-loading" role="status">Loading…</div>
        ) : error ? (
          <Empty icon={icon} title={`Could not load ${title.toLowerCase()}`} text={error}
            action={<button type="button" className="btn secondary" onClick={() => load()}>Retry</button>} />
        ) : rows.length ? (
          <>
            <table>
              <thead>
                <tr>
                  <th>{cols[0]?.label || "Name"}</th>

                  {cols.slice(1).map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}

                  {extraColumn ? (
                    <th>{extraColumn.title}</th>
                  ) : null}

                  <th />
                </tr>
              </thead>

              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    {cols.map((c, i) =>
                      i === 0 ? (
                        <td key={c.key}>
                          <button
                            className="person-cell person-link"
                            onClick={() =>
                              navigate(`/${resource}/${row.id}`)
                            }
                          >
                            <Avatar
                              name={nameOf(row)}
                              src={row.avatar || row.logo}
                            />

                            <div>
                              <b>{nameOf(row)}</b>

                              {synopsis ? (
                                <small>{synopsis(row)}</small>
                              ) : null}
                            </div>
                          </button>
                        </td>
                      ) : c.key === statusField ? (
                        <td key={c.key}>
                          <Badge
                            tone={toneOf(row[statusField!])}
                          >
                            {row[statusField!] || "—"}
                          </Badge>
                        </td>
                      ) : (
                        <td key={c.key}>{cell(row, c)}</td>
                      ),
                    )}

                    {extraColumn ? (
                      <td>{extraColumn.render(row)}</td>
                    ) : null}

                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-btn tiny"
                          onClick={() => setEdit(row)}
                          title="Edit"
                        >
                          <Icon name="edit" />
                          <Avatar
                            name={nameOf(row)}
                            src={row.avatar || row.logo}
                          />
                          <div>
                           <div className="lead-name-row">
  <b>{nameOf(row)}</b>
  {resource === "leads" &&
  typeof row.leadScore === "number" ? (
  <span title="AI Score — based on engagement signals">
  <Badge
    tone={
      row.leadScore <= 40
        ? "red"
        : row.leadScore <= 70
          ? "amber"
          : "green"
    }
  >
    {row.leadScore}
  </Badge>
</span>
  ) : null}
</div>
{synopsis ? <small>{synopsis(row)}</small> : null}
                          </div>
                        </button>

                        <button
                          className="icon-btn tiny danger-link"
                          onClick={() =>
                            confirm(
                              `Delete ${nameOf(row)}?`,
                            ) && remove(row.id)
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

            <div className="table-pagination">
              <button
                className="btn secondary compact"
                disabled={page <= 1}
                onClick={() =>
                  setPage((current) => current - 1)
                }
              >
                Previous
              </button>

              <span>
                Page {page} of {totalPages}
              </span>

              <button
                className="btn secondary compact"
                disabled={page >= totalPages}
                onClick={() =>
                  setPage((current) => current + 1)
                }
              >
                Next
              </button>
            </div>
          </>
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

      {edit !== undefined ? (
        renderEditor ? (
          renderEditor({
            title: `${edit ? "Edit" : "Add"} ${singular}`,
            initial: edit || {},
            onClose: () => setEdit(undefined),
            onSave: async (data) => {
              edit ? await update(edit.id, data) : await create(data);
              setEdit(undefined);
            },
          })
        ) : (
          <RecordForm
            title={`${edit ? "Edit" : "Add"} ${singular}`}
            fields={fields}
            initial={edit || {}}
            onClose={() => setEdit(undefined)}
            onSave={async (data) => {
              edit ? await update(edit.id, data) : await create(data);
              setEdit(undefined);
            }}
          />
        )
      ) : null}
    </div>
  );
}
