import { useEffect, useState, type KeyboardEvent } from "react";
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
import { Badge, Empty, PageHeader } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { CsvImportButton } from "../../components/imports/CsvImportWizard";
import { downloadResourceCsv } from "../../components/records/downloadResourceCsv";
import { getPageSize, savePageSize } from "../../components/records/preferences";
import { canManageRecords } from "../../components/records/rbac";
import { isActivationKey } from "../../components/records/keyboard";
import { RecordForm } from "../../components/records/RecordForm";
import { useDebouncedValue } from "../../components/records/useDebouncedValue";
import { useSchema } from "../../components/records/useSchema";
import { safeMediaSrc } from "../../components/records/urlSecurity";
import { companyFields } from "./fields";
import type { FieldSpec, Row } from "../../components/records/types";

export function CompaniesPage() {
  const [filters, setFilters] = useState<FilterGroup | null>(null);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim());
  const [pageSize, setPageSize] = useState(getPageSize);
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const { toast, user } = useApp();
  const navigate = useNavigate();
  const schema = useSchema("companies");
  const custom = schema.fields.filter(
    (field) => !companyFields.some((base) => base.key === field.key),
  );
  const formFields: FieldSpec[] = [
    { key: "logo", label: "Logo", type: "photo" },
    ...companyFields,
    ...custom,
  ];
  const restricted = {
    hiddenFields: schema.hiddenFields,
    maskedFields: schema.maskedFields,
  };
  const columnFields = [...companyFields, ...custom];
  const pickerColumns = filterRestrictedColumns(
    columnFields.map((column, index) => ({
      key: column.key,
      label: column.label,
      required: index === 0,
    })),
    restricted,
  );
  const tableColumns = filterRestrictedColumns(columnFields, restricted);
  const preferences = useColumnPreferences(
    "companies",
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
  } = useResource<Row>("companies", {
    page,
    limit: pageSize,
    q: debouncedQuery,
    filters,
  });
  const bulk = useBulkSelection(
    JSON.stringify(["companies", debouncedQuery, filters, page]),
    items.map((row) => row.id),
  );
  const canBulk = canManageRecords(user?.role);

  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, pageSize, filters]);

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
      await downloadResourceCsv("companies");
    } catch (cause) {
      toast((cause as Error).message, "error");
    }
  }

  function open(id: string) {
    navigate(`/companies/${id}`);
  }

  function onCardKeyDown(event: KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    if (isActivationKey(event.key)) {
      event.preventDefault();
      open(id);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Companies"
        description="Accounts, organizations and relationship ownership."
      >
        <CsvImportButton
          resource="companies"
          label="Companies"
          fields={columnFields}
          onComplete={load}
        />
        <button className="btn secondary" disabled={!items.length} onClick={exportCsv}>
          <Icon name="download" /> Export
        </button>
        {canBulk ? (
          <button className="btn primary" onClick={() => setEdit(null)}>
            <Icon name="plus" /> Add company
          </button>
        ) : null}
      </PageHeader>
      <FilterBuilder
        fields={formFields}
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
              aria-label="Search companies"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search companies"
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
        {canBulk && (
          <label>
            <SelectPage
              ids={items.map((row) => row.id)}
              selected={bulk.selected}
              onChange={bulk.setSelected}
              disabled={bulk.busy || loading}
            />{" "}
            Select visible companies (maximum 100)
          </label>
        )}
        {loading ? (
          <div role="status">Loading…</div>
        ) : error ? (
          <Empty
            icon="companies"
            title="Could not load companies"
            text={error}
            action={
              <button type="button" className="btn secondary" onClick={() => load()}>
                Retry
              </button>
            }
          />
        ) : items.length ? (
          <>
            <div className="company-grid">
              {items.map((company) => (
                <article
                  className="company-card"
                  key={company.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${company.name || "company"}`}
                  onClick={() => open(company.id)}
                  onKeyDown={(event) => onCardKeyDown(event, company.id)}
                >
                  {canBulk && (
                    <label
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <input
                        className="bulk-select"
                        type="checkbox"
                        aria-label={`Select ${company.name || company.id}`}
                        checked={bulk.selected.includes(company.id)}
                        disabled={
                          bulk.busy ||
                          (!bulk.selected.includes(company.id) && bulk.selected.length >= 100)
                        }
                        onChange={() => bulk.toggle(company.id)}
                      />{" "}
                      Select
                    </label>
                  )}
                  <header>
                    <span className="company-logo">
                      {safeMediaSrc(company.logo) ? (
                        <img src={safeMediaSrc(company.logo)} alt="" />
                      ) : (
                        String(company.name || "NX")
                          .split(/\s+/)
                          .map((part: string) => part[0])
                          .join("")
                          .slice(0, 2)
                          .toUpperCase()
                      )}
                    </span>
                    {canBulk ? (
                    <div
                      className="row-actions"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <button
                        className="icon-btn tiny"
                        aria-label={`Edit ${company.name || "company"}`}
                        onClick={() => setEdit(company)}
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        className="icon-btn tiny danger-link"
                        aria-label={`Delete ${company.name || "company"}`}
                        onClick={() =>
                          confirm("Delete this company?") && remove(company.id)
                        }
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  ) : null}
                  </header>
                  <h3>{company.name || "Untitled company"}</h3>
                  <p>
                    {company.industry || "No industry"}
                    {company.country ? ` · ${company.country}` : ""}
                  </p>
                  <div className="company-meta">
                    {visibleColumns.slice(1).map((column) => (
                      <span key={column.key}>
                        <small>{column.label}</small>
                        <b>{company[column.key] ?? "—"}</b>
                      </span>
                    ))}
                  </div>
                  <footer>
                    <Badge>{company.website || "No website"}</Badge>
                    <span className="link-btn">Open account</span>
                  </footer>
                </article>
              ))}
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
            icon="companies"
            title={query ? "No companies found" : "No companies"}
            text={
              query
                ? "Try another search term."
                : "Add companies to connect contacts and deals to accounts."
            }
            action={
              !query && canBulk ? (
                <button className="btn primary compact" onClick={() => setEdit(null)}>
                  Add company
                </button>
              ) : undefined
            }
          />
        )}
      </section>
      {canBulk && (
        <BulkActions
          resource="companies"
          ids={bulk.selected}
          busy={bulk.busy}
          setBusy={bulk.setBusy}
          onSelection={bulk.setSelected}
          onReload={load}
        />
      )}
      {edit !== undefined ? (
        <RecordForm
          title={`${edit ? "Edit" : "Add"} company`}
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
