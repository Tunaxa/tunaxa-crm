import { useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useResource } from "../../lib/useResource";
import { useApp } from "../../context/AppContext";
import { PageHeader, money, Badge, Empty } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { RecordForm } from "../../components/records/RecordForm";
import { useSchema } from "../../components/records/useSchema";
import { canManageRecords } from "../../components/records/rbac";
import { dealFields, stages } from "./fields";
import { moveDealToStage, pipelineMoveMessage } from "./pipelineActions";
import type { FieldSpec, Row } from "../../components/records/types";

export function PipelinePage() {
  const { items, loading, error, load, create, update, remove } = useResource<Row>("deals", {
    all: true,
  });
  const navigate = useNavigate();
  const { toast, user } = useApp();
  const canEdit = canManageRecords(user?.role);
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const [dragging, setDragging] = useState<string | null>(null);
  const [moveError, setMoveError] = useState("");
  const schema = useSchema("deals");
  const custom = schema.fields.filter(
    (field) => !dealFields.some((base) => base.key === field.key),
  );
  const fields: FieldSpec[] = [...dealFields, ...custom];

  function reportError(message: string) {
    setMoveError(message);
    toast(message, "error");
  }

  async function drop(stage: string, event?: DragEvent<HTMLElement>) {
    const id = event?.dataTransfer?.getData("text/plain") || dragging;
    setDragging(null);
    if (!id) return;
    if (!canEdit) return;
    setMoveError("");
    await moveDealToStage(update, id, stage, reportError);
  }

  async function moveWithKeyboard(id: string, stage: string) {
    if (!canEdit) return;
    setMoveError("");
    await moveDealToStage(update, id, stage, reportError);
  }

  async function deleteDeal(id: string) {
    if (!canEdit || !confirm("Delete this deal?")) return;
    try {
      await remove(id);
    } catch (cause) {
      toast(pipelineMoveMessage(cause), "error");
    }
  }

  return (
    <div className="page pipeline-page">
      <PageHeader
        title="Pipeline"
        description="Drag deals between stages and keep your pipeline moving."
      >
        {canEdit ? (
          <button className="btn primary" onClick={() => setEdit(null)}>
            <Icon name="plus" /> Add deal
          </button>
        ) : null}
      </PageHeader>
      {moveError ? (
        <p className="inline-alert error" role="alert">
          <Icon name="warning" /> {moveError}
        </p>
      ) : null}
      {loading ? (
        <p role="status">Loading deals…</p>
      ) : error ? (
        <Empty
          icon="pipeline"
          title="Could not load deals"
          text={error}
          action={
            <button type="button" className="btn secondary" onClick={() => load()}>
              Retry
            </button>
          }
        />
      ) : items.length ? (
        <div className="pipeline-board">
          {stages.map((stage) => {
            const rows = items.filter((item) => (item.stage || "new") === stage.id);
            return (
              <section
                className="pipeline-column"
                key={stage.id}
                onDragOver={(event) => {
                  if (canEdit) event.preventDefault();
                }}
                onDrop={(event) => {
                  if (!canEdit) return;
                  event.preventDefault();
                  void drop(stage.id, event);
                }}
              >
                <header>
                  <div>
                    <span className="dot" />
                    <b>{stage.label}</b>
                    <em>{rows.length}</em>
                  </div>
                  <strong>
                    {money(rows.reduce((sum, row) => sum + Number(row.value || 0), 0))}
                  </strong>
                </header>
                <div className="deal-list">
                  {rows.map((row) => (
                    <article
                      className="deal-card"
                      key={row.id}
                      draggable={canEdit}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/plain", row.id);
                        setDragging(row.id);
                      }}
                      onDragEnd={() => setDragging(null)}
                    >
                      <div className="deal-top">
                        <Badge tone={stage.id === "won" ? "green" : "blue"}>{stage.label}</Badge>
                        {canEdit ? (
                          <div className="row-actions">
                            <button
                              className="icon-btn tiny"
                              aria-label={`Edit ${row.title || "deal"}`}
                              onClick={() => setEdit(row)}
                            >
                              <Icon name="edit" />
                            </button>
                            <button
                              className="icon-btn tiny danger-link"
                              aria-label={`Delete ${row.title || "deal"}`}
                              onClick={() => deleteDeal(row.id)}
                            >
                              <Icon name="trash" />
                            </button>
                          </div>
                        ) : null}
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
                      {canEdit ? (
                        <label className="pipeline-stage-move">
                          <span>Move to</span>
                          <select
                            aria-label={`Move ${row.title || "deal"} to stage`}
                            value={stage.id}
                            onChange={(event) =>
                              moveWithKeyboard(row.id, event.target.value)
                            }
                          >
                            {stages.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                    </article>
                  ))}
                  {canEdit ? (
                    <button
                      className="add-deal"
                      onClick={() => setEdit({ id: "", stage: stage.id })}
                    >
                      <Icon name="plus" /> Add deal
                    </button>
                  ) : null}
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
            canEdit ? (
              <button className="btn primary compact" onClick={() => setEdit(null)}>
                Add deal
              </button>
            ) : undefined
          }
        />
      )}
      {edit !== undefined && canEdit ? (
        <RecordForm
          title={`${edit?.id ? "Edit" : "Add"} deal`}
          fields={fields}
          initial={edit?.id ? edit : { stage: edit?.stage || "new" }}
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
