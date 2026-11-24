import { type ReactNode, useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useResource } from "../../lib/useResource";
import { useApp } from "../../context/AppContext";
import { api, json } from "../../lib/api";
import { ColumnPicker } from "../ColumnPicker";
import {
  filterRestrictedColumns,
  useColumnPreferences,
  workspaceIdOf,
} from "../columnPreferences";
import { money, PageHeader, Avatar, Badge, Empty } from "../ui";
import { Icon } from "../Icon";
import { RecordForm } from "./RecordForm";
import { downloadResourceCsv } from "./downloadResourceCsv";
import { showMoney } from "./formatters";
import { getPageSize, savePageSize } from "./preferences";
import { canManageRecords } from "./rbac";
import { sanitizeCsvRecords, safeMediaSrc } from "./urlSecurity";
import { useDebouncedValue } from "./useDebouncedValue";
import { useSchema } from "./useSchema";
import type { BadgeTone, FieldSpec, Row } from "./types";

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
    initial: Row | Record<string, unknown>;
    onClose: () => void;
    onSave: (data: Record<string, unknown>) => Promise<void>;
  }) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim());
  const [pageSize, setPageSize] = useState(getPageSize);
  const [page, setPage] = useState(1);
  const { toast, user } = useApp();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const schema = useSchema(resource);
  const custom = schema.fields.filter(
    (field) => !fields.some((base) => base.key === field.key),
  );
  const editorFields = [...fields, ...custom];
  const baseColumns = columns || editorFields;
  const restricted = {
    hiddenFields: schema.hiddenFields,
    maskedFields: schema.maskedFields,
  };
  const pickerColumns = filterRestrictedColumns(
    baseColumns.map((column, index) => ({
      key: column.key,
      label: column.label,
      required: index === 0,
    })),
    restricted,
  );
  const tableColumns = filterRestrictedColumns(baseColumns, restricted);
  const preferences = useColumnPreferences(
    resource,
    pickerColumns,
    user?.id || "anonymous",
    workspaceIdOf(user),
  );
  const visibleColumns = tableColumns.filter((column) =>
    preferences.visibleKeys.includes(column.key),
  );
  const {
    items,
    loading,
    error,
    load,
    create,
    update,
    remove,
    total,
    totalPages,
  } = useResource<Row>(resource, {
    page,
    limit: pageSize,
    q: debouncedQuery,
  });
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const canEdit = canManageRecords(user?.role);

  const moneyKeys = new Set(moneyColumn ?? baseColumns.map((column) => column.key));
  const singular = title.slice(0, -1).toLowerCase();
  const nameOf = (row: Row) =>
    primary ? primary(row) : String(row[nameKey] || "Untitled");
  const toneOf =
    statusTone ||
    ((value?: string): BadgeTone =>
      ["Active", "Paid", "Approved", "Published", "Delivered", "Present", "Completed"].includes(
        value ?? "",
      )
        ? "green"
        : ["Lost", "Cancelled", "Rejected", "Absent", "Overdue", "Terminated"].includes(
              value ?? "",
            )
          ? "red"
          : "blue");

  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, pageSize, resource]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  function changePageSize(value: number) {
    setPageSize(value);
    setPage(1);
    savePageSize(value);
  }

  async function importCsv(file: File) {
    try {
      const text = await file.text();
      const allowed = editorFields.map((field) => field.key);
      const { records, rejectedHeaders } = sanitizeCsvRecords(text, allowed);
      if (!records.length) return toast("CSV has no importable rows", "error");
      await api(`/${resource}/batch`, json("POST", records));
      await load();
      toast(
        `${records.length} rows imported${rejectedHeaders.length ? ` (${rejectedHeaders.length} headers ignored)` : ""}`,
      );
    } catch (cause) {
      toast((cause as Error).message, "error");
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
    if (showMoney(field.key) && moneyKeys.has(field.key)) return money(Number(value));
    if (field.type === "date") return String(value).slice(0, 10);
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  }

  return (
    <div className="page">
      <PageHeader title={title} description={description}>
        {canEdit ? (
          <input
            ref={inputRef}
            hidden
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importCsv(file);
            }}
          />
        ) : null}
        {canEdit ? (
          <button className="btn secondary" onClick={() => inputRef.current?.click()}>
            <Icon name="upload" /> Import
          </button>
        ) : null}
        <button className="btn secondary" onClick={exportCsv}>
          <Icon name="download" /> Export
        </button>
        {canEdit ? (
          <button className="btn primary" onClick={() => setEdit(null)}>
            <Icon name="plus" /> Add {singular}
          </button>
        ) : null}
      </PageHeader>
      <section className="surface table-surface">
        <div className="table-toolbar">
          <div className="header-search">
            <Icon name="search" />
            <input
              aria-label={`Search ${title.toLowerCase()}`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${title.toLowerCase()}`}
            />
          </div>
          <ColumnPicker
            columns={pickerColumns}
            visibleKeys={preferences.visibleKeys}
            onChange={preferences.change}
            saveError={preferences.saveError}
          />
          <span className="table-count">{total} total</span>
          <select
            value={pageSize}
            onChange={(event) => changePageSize(Number(event.target.value))}
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
          <Empty
            icon={icon}
            title={`Could not load ${title.toLowerCase()}`}
            text={error}
            action={
              <button type="button" className="btn secondary" onClick={() => load()}>
                Retry
              </button>
            }
          />
        ) : visibleColumns.length && items.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {visibleColumns.map((column) => (
                      <th key={column.key}>{column.label}</th>
                    ))}
                    {extraColumn ? <th>{extraColumn.title}</th> : null}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.id}>
                      {visibleColumns.map((column, index) =>
                        index === 0 ? (
                          <td key={column.key}>
                            <button
                              className="person-cell person-link"
                              onClick={() => navigate(`/${resource}/${row.id}`)}
                            >
                              <Avatar
                                name={nameOf(row)}
                                src={safeMediaSrc(row.avatar || row.logo)}
                              />
                              <div>
                                <b>{nameOf(row)}</b>
                                {resource === "leads" && typeof row.leadScore === "number" ? (
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
                                ) : null}
                                {synopsis ? <small>{synopsis(row)}</small> : null}
                              </div>
                            </button>
                          </td>
                        ) : statusField && column.key === statusField ? (
                          <td key={column.key}>
                            <Badge tone={toneOf(row[statusField])}>
                              {row[statusField] || "—"}
                            </Badge>
                          </td>
                        ) : (
                          <td key={column.key}>{cell(row, column)}</td>
                        ),
                      )}
                      {extraColumn ? <td>{extraColumn.render(row)}</td> : null}
                      <td>
                        {canEdit ? (
                          <div className="row-actions">
                            <button
                              className="icon-btn tiny"
                              aria-label={`Edit ${nameOf(row)}`}
                              onClick={() => setEdit(row)}
                            >
                              <Icon name="edit" />
                            </button>
                            <button
                              className="icon-btn tiny danger-link"
                              aria-label={`Delete ${nameOf(row)}`}
                              onClick={() =>
                                confirm(`Delete ${nameOf(row)}?`) && remove(row.id)
                              }
                            >
                              <Icon name="trash" />
                            </button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-pagination">
              <button
                className="btn secondary compact"
                disabled={page <= 1}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous
              </button>
              <span>
                Page {page} of {totalPages}
              </span>
              <button
                className="btn secondary compact"
                disabled={page >= totalPages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </div>
          </>
        ) : (
          <Empty
            icon={icon}
            title={query ? `No ${title.toLowerCase()} found` : `No ${title.toLowerCase()} yet`}
            text={
              query
                ? "Try another search term."
                : `Add your first ${singular} or import a CSV file.`
            }
            action={
              !query && canEdit ? (
                <button className="btn primary compact" onClick={() => setEdit(null)}>
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
              if (edit?.id) await update(edit.id, data);
              else await create(data);
              setEdit(undefined);
            },
          })
        ) : (
          <RecordForm
            title={`${edit ? "Edit" : "Add"} ${singular}`}
            fields={editorFields}
            initial={edit || {}}
            onClose={() => setEdit(undefined)}
            onSave={async (data) => {
              if (edit?.id) await update(edit.id, data);
              else await create(data);
              setEdit(undefined);
            }}
          />
        )
      ) : null}
    </div>
  );
}
