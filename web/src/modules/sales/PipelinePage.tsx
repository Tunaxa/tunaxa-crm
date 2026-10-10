import { CsvImportButton } from "../../components/imports/CsvImportWizard";
import { useResource } from "../../lib/useResource";
import { type Row, type FieldSpec } from "../../components/records/types";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useSchema } from "../../components/records/useSchema";
import { stages } from "./fields";
import { PageHeader, money, Badge, Empty } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { RecordForm } from "../../components/records/RecordForm";

export function PipelinePage() {
  const { items, loading, error, load, create, update, remove } = useResource<Row>("deals", { all: true });
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
        <CsvImportButton resource="deals" label="Deals" fields={allFields} onComplete={load} />
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Icon name="plus" /> Add deal
        </button>
      </PageHeader>
      {loading ? <p role="status">Loading deals…</p> : error ? (
        <Empty icon="pipeline" title="Could not load deals" text={error}
          action={<button type="button" className="btn secondary" onClick={() => load()}>Retry</button>} />
      ) : items.length ? (
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
