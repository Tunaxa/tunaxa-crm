import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { FilterBuilder, type FilterGroup } from "../../components/FilterBuilder";
import { useResource } from "../../lib/useResource";
import { useApp } from "../../context/AppContext";
import { BulkActions, SelectPage, useBulkSelection } from "../../components/BulkActions";
import { ColumnPicker } from "../../components/ColumnPicker";
import {
  filterRestrictedColumns,
  useColumnPreferences,
  workspaceIdOf,
} from "../../components/columnPreferences";
import { Avatar, Badge, Empty, PageHeader, money } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { CsvImportButton } from "../../components/imports/CsvImportWizard";
import { downloadResourceCsv } from "../../components/records/downloadResourceCsv";
import { getPageSize, savePageSize } from "../../components/records/preferences";
import { canManageRecords } from "../../components/records/rbac";
import { showMoney } from "../../components/records/formatters";
import { RecordForm } from "../../components/records/RecordForm";
import { useDebouncedValue } from "../../components/records/useDebouncedValue";
import { useSchema } from "../../components/records/useSchema";
import { safeMediaSrc } from "../../components/records/urlSecurity";
import type { BadgeTone, FieldSpec, Row } from "../../components/records/types";

export function PeoplePage({
  resource,
  title,
  description,
  icon,
  fields,
}: {
  resource: "leads" | "contacts";
  title: string;
  description: string;
  icon: string;
  fields: FieldSpec[];
}) {
  const [filters, setFilters] = useState<FilterGroup | null>(null);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim());
  const [pageSize, setPageSize] = useState(getPageSize);
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const { toast, user } = useApp();
  const navigate = useNavigate();
  const schema = useSchema(resource);
  const custom = schema.fields.filter(
    (field) => !fields.some((base) => base.key === field.key),
  );
  const allFields = [...fields, ...custom];
  const formFields = [
    { key: "avatar", label: "Photo", type: "photo" as const },
    ...allFields.filter((field) => field.key !== "avatar"),
  ];
  const restricted = {
    hiddenFields: schema.hiddenFields,
    maskedFields: schema.maskedFields,
  };
  const pickerColumns = filterRestrictedColumns(
    allFields.map((column, index) => ({
      key: column.key,
      label: column.label,
      required: index === 0,
    })),
    restricted,
  );
  const tableColumns = filterRestrictedColumns(allFields, restricted);
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
    filters,
  });
  const bulk = useBulkSelection(
    JSON.stringify([resource, debouncedQuery, filters, page]),
    items.map((row) => row.id),
  );
  const canBulk = canManageRecords(user?.role);
  const moneyKeys = new Set(allFields.map((field) => field.key));
  const singular = title.slice(0, -1).toLowerCase();
  const nameOf = (row: Row) => String(row.name || row.title || "Untitled");
  const toneOf = (value?: string): BadgeTone =>
    ["Active", "Qualified", "Won"].includes(value ?? "")
      ? "green"
      : ["Lost", "Disabled"].includes(value ?? "")
        ? "red"
        : "blue";

  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, pageSize, resource, filters]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  function changePageSize(value: number) {
    setPageSize(value);
    setPage(1);
    savePageSize(value);
  }

  async function exportCsv() {
    try {
      await downloadResourceCsv(resource);
    } catch (cause) {
      toast((cause as Error).message, "error");
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
        <CsvImportButton
          resource={resource}
          label={title}
          fields={allFields}
          onComplete={load}
        />
        <button className="btn secondary" onClick={exportCsv}>
          <Icon name="download" /> Export CSV
        </button>
        {canBulk ? (
          <button className="btn primary" onClick={() => setEdit(null)}>
            <Icon name="plus" /> Add {singular}
          </button>
        ) : null}
      </PageHeader>
      <FilterBuilder
        fields={allFields}
        value={filters}
        onChange={(next) => {
          if (!bulk.busy) setFilters(next);
        }}
      />
      <section className="surface table-surface">
        <div className="table-toolbar">
          <div className="header-search">
            <Icon name="search" />
            <input
              aria-label={`Search ${title.toLowerCase()}`}
              value={query}
              disabled={bulk.busy}
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
        {error ? (
          <p role="alert">
            {error}{" "}
            <button type="button" onClick={() => load()}>
              Retry
            </button>
          </p>
        ) : null}
        {loading ? (
          <div className="table-loading" role="status">Loading…</div>
        ) : items.length && visibleColumns.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {canBulk && (
                      <th>
                        <SelectPage
                          ids={items.map((row) => row.id)}
                          selected={bulk.selected}
                          onChange={bulk.setSelected}
                          disabled={bulk.busy}
                        />
                      </th>
                    )}
                    {visibleColumns.map((column) => (
                      <th key={column.key}>{column.label}</th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.id}>
                      {canBulk && (
                        <td>
                          <input
                            className="bulk-select"
                            type="checkbox"
                            aria-label={`Select ${nameOf(row)}`}
                            checked={bulk.selected.includes(row.id)}
                            disabled={
                              bulk.busy ||
                              (!bulk.selected.includes(row.id) && bulk.selected.length >= 100)
                            }
                            onChange={() => bulk.toggle(row.id)}
                          />
                        </td>
                      )}
                      {visibleColumns.map((column, index) =>
                        index === 0 ? (
                          <td key={column.key}>
                            <button
                              className="person-cell person-link"
                              onClick={() => navigate(`/${resource}/${row.id}`)}
                            >
                              <Avatar name={nameOf(row)} src={safeMediaSrc(row.avatar || row.logo)} />
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
                                <small>{row.company || row.role || row.source || "—"}</small>
                              </div>
                            </button>
                          </td>
                        ) : column.key === "status" ? (
                          <td key={column.key}>
                            <Badge tone={toneOf(row.status)}>{row.status || "—"}</Badge>
                          </td>
                        ) : (
                          <td key={column.key}>{cell(row, column)}</td>
                        ),
                      )}
                      <td>
                        {canBulk ? (
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
              !query && canBulk ? (
                <button className="btn primary compact" onClick={() => setEdit(null)}>
                  Add {singular}
                </button>
              ) : undefined
            }
          />
        )}
      </section>
      {canBulk && (
        <BulkActions
          resource={resource}
          ids={bulk.selected}
          statuses={allFields.find((field) => field.key === "status")?.options}
          busy={bulk.busy}
          setBusy={bulk.setBusy}
          onSelection={bulk.setSelected}
          onReload={load}
        />
      )}
      {edit !== undefined ? (
        <RecordForm
          title={`${edit ? "Edit" : "Add"} ${singular}`}
          fields={formFields}
          initial={edit || {}}
          onClose={() => setEdit(undefined)}
          onSave={async (data) => {
            if (edit?.id) await update(edit.id, data);
            else await create(data);
            setEdit(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
