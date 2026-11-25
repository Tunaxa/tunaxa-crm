import { useRef, useState } from "react";
import { Drawer } from "../../../components/ui";
import {
  LEGACY_PIPELINE,
  pipelinePayload,
  type PipelineDefinition,
  type PipelinePayload,
  type StageDraft,
} from "./pipelineDefinitions";

function messageOf(failure: unknown): string {
  return failure instanceof Error && failure.message.trim()
    ? failure.message
    : "The pipeline action could not be completed";
}

export function PipelineEditor({
  initial,
  occupied,
  busy,
  canManage,
  error = "",
  onClose,
  onSave,
  onSetDefault,
  onDelete,
}: {
  initial?: PipelineDefinition;
  occupied: string[];
  busy: boolean;
  canManage: boolean;
  error?: string;
  onClose: () => void;
  onSave: (payload: PipelinePayload) => Promise<void>;
  onSetDefault: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const nextId = useRef(0);
  const [name, setName] = useState(initial?.name || "");
  const [rows, setRows] = useState<StageDraft[]>(() =>
    (initial?.stages || LEGACY_PIPELINE.stages).map((stage, index) => ({
      uid: `initial_${index}`,
      key: stage.key,
      label: stage.label,
      probability: String(stage.probability),
    })),
  );
  const [localError, setLocalError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const locked = busy || submitting;
  const shownError = error || localError;

  function close() {
    if (!locked) onClose();
  }

  function change(index: number, patch: Partial<StageDraft>) {
    setRows((current) =>
      current.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    );
  }

  function reorder(index: number, offset: number) {
    setRows((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const moved = next[index];
      next[index] = next[target];
      next[target] = moved;
      return next;
    });
  }

  function addStage() {
    if (rows.length >= 20) {
      setLocalError("A pipeline can have at most 20 stages");
      return;
    }
    nextId.current += 1;
    const suffix = String(nextId.current);
    setRows((current) => [
      ...current,
      {
        uid: `new_${suffix}`,
        key: `stage_${suffix}`,
        label: "",
        probability: "0",
      },
    ]);
  }

  async function save() {
    if (locked || !canManage) return;
    setLocalError("");
    setSubmitting(true);
    try {
      await onSave(
        pipelinePayload(name, rows, {
          entityType: initial?.entityType ?? "deal",
          isDefault: initial?.isDefault ?? false,
        }),
      );
    } catch (failure) {
      setLocalError(messageOf(failure));
    } finally {
      setSubmitting(false);
    }
  }

  async function runAction(action: (id: string) => Promise<void>) {
    if (!initial?.id || !canManage || locked) return;
    setLocalError("");
    setSubmitting(true);
    try {
      await action(initial.id);
    } catch (failure) {
      setLocalError(messageOf(failure));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Drawer
      title={initial ? "Edit pipeline" : "Create pipeline"}
      subtitle="Define stages and their probability of winning a deal."
      width={760}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn secondary" disabled={locked} onClick={close}>
            Cancel
          </button>
          {canManage ? (
            <button type="button" className="btn primary" disabled={locked} onClick={() => void save()}>
              {locked ? "Saving…" : "Save pipeline"}
            </button>
          ) : null}
        </>
      }
    >
      <div className="pipeline-editor" aria-label="Pipeline builder">
        {shownError ? <p role="alert">{shownError}</p> : null}
        {locked ? <p role="status">Saving pipeline…</p> : null}
        <label className="field">
          <span>Pipeline name *</span>
          <input
            value={name}
            disabled={!canManage || locked}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <p>
          Stage order follows this list. Move all deals out of a stage before removing it.
        </p>
        <ol className="pipeline-stage-editor">
          {rows.map((stage, index) => (
            <li key={stage.uid || `${stage.key}_${index}`}>
              <label className="field">
                <span>Stage key *</span>
                <input
                  value={stage.key}
                  disabled={!canManage || locked}
                  onChange={(event) => change(index, { key: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Stage {index + 1} name *</span>
                <input
                  value={stage.label}
                  disabled={!canManage || locked}
                  onChange={(event) => change(index, { label: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Win probability (%) *</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={stage.probability}
                  disabled={!canManage || locked}
                  onChange={(event) => change(index, { probability: event.target.value })}
                />
              </label>
              <div className="pipeline-stage-actions">
                <button
                  type="button"
                  className="btn secondary compact"
                  aria-label={`Move stage ${index + 1} up`}
                  disabled={!canManage || locked || index === 0}
                  onClick={() => reorder(index, -1)}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="btn secondary compact"
                  aria-label={`Move stage ${index + 1} down`}
                  disabled={!canManage || locked || index === rows.length - 1}
                  onClick={() => reorder(index, 1)}
                >
                  Down
                </button>
                {canManage && initial ? (
                  <button
                    type="button"
                    className="btn secondary compact"
                    aria-label={`Remove stage ${index + 1}`}
                    disabled={locked || rows.length === 1 || occupied.includes(stage.key)}
                    onClick={() =>
                      setRows((current) => current.filter((_, at) => at !== index))
                    }
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              {occupied.includes(stage.key) ? <small>Contains deals; removal is disabled.</small> : null}
            </li>
          ))}
        </ol>
        {canManage ? (
          <button type="button" className="btn secondary" disabled={locked || rows.length >= 20} onClick={addStage}>
            Add stage
          </button>
        ) : null}
        {canManage && initial ? (
          <div className="pipeline-editor-actions">
            <button
              type="button"
              className="btn secondary"
              disabled={locked}
              onClick={() => void runAction((id) => onSetDefault(id))}
            >
              Set as default
            </button>
            <button
              type="button"
              className="btn secondary danger-link"
              disabled={locked}
              onClick={() => void runAction((id) => onDelete(id))}
            >
              Delete pipeline
            </button>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
