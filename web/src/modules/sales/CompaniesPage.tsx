import { type FieldSpec, type Row } from "../../components/records/types";
import { useState } from "react";
import { type FilterGroup, FilterBuilder } from "../../components/FilterBuilder";
import { useResource } from "../../lib/useResource";
import { useApp } from "../../context/AppContext";
import { useNavigate } from "react-router-dom";
import { useSchema } from "../../components/records/useSchema";
import { useBulkSelection, SelectPage, BulkActions } from "../../components/BulkActions";
import { downloadResourceCsv } from "../../components/records/downloadResourceCsv";
import { PageHeader, Badge, Empty } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { RecordForm } from "../../components/records/RecordForm";

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
      {canBulk && <label><SelectPage ids={items.map((row) => row.id)} selected={bulk.selected} onChange={bulk.setSelected} disabled={bulk.busy || loading} /> Select visible companies (maximum 100)</label>}
      {loading ? <div role="status">Loading…</div> : error ? (
        <Empty icon="companies" title="Could not load companies" text={error}
          action={<button type="button" className="btn secondary" onClick={() => load()}>Retry</button>} />
      ) : items.length ? (
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
