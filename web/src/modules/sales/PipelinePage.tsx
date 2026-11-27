import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useResource } from "../../lib/useResource";
import { useApp } from "../../context/AppContext";
import { PageHeader, money, Badge, Empty, RevenueTicker } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { CsvImportButton } from "../../components/imports/CsvImportWizard";
import { RecordForm } from "../../components/records/RecordForm";
import { useSchema } from "../../components/records/useSchema";
import { canManageRecords } from "../../components/records/rbac";
import { showMoney } from "../../components/records/formatters";
import { hasOwn } from "../../components/records/urlSecurity";
import type { FieldSpec, Row } from "../../components/records/types";
import { dealFields } from "./fields";
import { pipelineMoveMessage } from "./pipelineActions";
import { PipelineEditor } from "./pipelines/PipelineEditor";
import { usePipelineDefinitions } from "./pipelines/usePipelineDefinitions";
import {
  checkDealSave,
  dealPayload,
  defaultDefinition,
  importDealPayload,
  LEGACY_PIPELINE,
  occupiedStageKeys,
  ORPHAN_PIPELINE,
  pipelineDeals,
  stageForDeal,
  validateStageRemoval,
  canManagePipelines,
  type PipelineDefinition,
} from "./pipelines/pipelineDefinitions";
import "./pipelines/pipelines.css";
import "./winFlashTicker.css";
import {
  dealAmount,
  isWonTransition,
  prefersReducedMotion,
  resourceFromEvent,
  safeDealRecord,
  transitionLabel,
  wonRevenue,
  wonStageKey,
} from "./winFlash";

type WinBanner = {
  title: string;
  transition: string;
  value: string;
};

export function PipelinePage() {
  const deals = useResource<Row>("deals", { all: true });
  const pipelines = usePipelineDefinitions();
  const { toast, user } = useApp();
  const navigate = useNavigate();
  const schema = useSchema("deals");
  const [selectedId, setSelectedId] = useState(() => {
    try {
      return localStorage.getItem("tunaxa.pipeline.selected") || "";
    } catch {
      return "";
    }
  });
  const [edit, setEdit] = useState<{ row?: Row; definition: PipelineDefinition } | null>(null);
  const [configure, setConfigure] = useState<PipelineDefinition | null | undefined>(undefined);
  const [importTarget, setImportTarget] = useState<PipelineDefinition | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [savingDeal, setSavingDeal] = useState(false);
  const [moveError, setMoveError] = useState("");
  const [pipelineError, setPipelineError] = useState("");
  const [winBanner, setWinBanner] = useState<WinBanner | null>(null);
  const [flashStage, setFlashStage] = useState("");
  const dealBusy = useRef(false);
  const columnRefs = useRef<Map<string, HTMLElement>>(new Map());
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const centeredRef = useRef<Map<string, string>>(new Map());
  const announcedRef = useRef<Set<string>>(new Set());
  const seenStagesRef = useRef<Map<string, string>>(new Map());
  const initializedRef = useRef(false);
  const canEditDeals = canManageRecords(user?.role);
  const canConfigure = canManagePipelines(user?.role);
  const definitions = pipelines.definitions;
  const selectedDefinition = definitions.find((row) => row.id === selectedId) || null;
  const fallbackDefinition = defaultDefinition(definitions) || LEGACY_PIPELINE;
  const current =
    selectedId === ORPHAN_PIPELINE ? null : selectedDefinition || fallbackDefinition;
  const currentId =
    current?.id || (selectedId === ORPHAN_PIPELINE ? ORPHAN_PIPELINE : "");
  const orphaned = definitions.length
    ? pipelineDeals(deals.items, ORPHAN_PIPELINE, definitions)
    : [];
  const rows = definitions.length
    ? pipelineDeals(deals.items, currentId, definitions)
    : deals.items;
  const importPipeline = importTarget || current;
  const pipelineReady =
    !pipelines.loading &&
    (!pipelines.error || (pipelines.unavailable && definitions.length === 0));
  const boardReady =
    pipelineReady &&
    !deals.loading &&
    !deals.error &&
    !savingDeal &&
    !pipelines.saving &&
    configure === undefined &&
    edit === null &&
    !importTarget;
  const canMoveDeal = canEditDeals && boardReady;
  const canAddDeal = Boolean(canMoveDeal && current?.stages.length);
  const importUnavailable = Boolean(
    !importPipeline ||
      !importPipeline.stages.length ||
      (importTarget?.id && !definitions.some((row) => row.id === importTarget.id)) ||
      (pipelines.error && !(pipelines.unavailable && !definitions.length)),
  );
  const currentStages = current?.stages || [];
  const canShowRevenue = canEditDeals && showMoney("value");
  const revenue = wonRevenue(deals.items, currentStages);

  const centerDealColumn = useCallback((id: string, stage: string) => {
    if (centeredRef.current.get(id) === stage) return;
    centeredRef.current.set(id, stage);
    const columnEl = columnRefs.current.get(stage);
    if (typeof columnEl?.scrollIntoView !== "function") return;
    columnEl.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      inline: "center",
      block: "nearest",
    });
  }, []);

  const announceWin = useCallback(
    (deal: unknown, previousStage?: unknown) => {
      if (!canShowRevenue) return;
      const record = safeDealRecord(deal);
      const id = hasOwn(record, "id") && typeof record.id === "string" ? record.id : "";
      const stage = hasOwn(record, "stage") ? record.stage : undefined;
      const stageKey = wonStageKey(stage, currentStages);
      if (!id || !stageKey || announcedRef.current.has(id)) return;
      if (previousStage !== undefined && !isWonTransition(previousStage, stage, currentStages)) {
        return;
      }
      const amount = hasOwn(record, "value") ? dealAmount(record.value) : null;
      if (amount === null) return;
      announcedRef.current.add(id);
      const title =
        hasOwn(record, "title") && typeof record.title === "string"
          ? record.title
          : "Untitled deal";
      const value = money(amount);
      setWinBanner({
        title,
        transition: transitionLabel(previousStage, stageKey, currentStages),
        value,
      });
      setFlashStage(stageKey);
      if (bannerTimerRef.current !== null) clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = setTimeout(() => {
        setWinBanner(null);
        bannerTimerRef.current = null;
      }, 2200);
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => {
        setFlashStage("");
        flashTimerRef.current = null;
      }, 1000);
      toast(`🎉 Deal won: ${value}`);
    },
    [canShowRevenue, currentStages, toast],
  );

  const syncWins = useCallback(
    (rows: readonly unknown[]) => {
      if (!canShowRevenue) return;
      const seen = seenStagesRef.current;
      const liveIds = new Set<string>();
      for (const row of rows) {
        const record = safeDealRecord(row);
        const id = hasOwn(record, "id") && typeof record.id === "string" ? record.id : "";
        if (!id) continue;
        liveIds.add(id);
        const stage = hasOwn(record, "stage") && typeof record.stage === "string" ? record.stage : "";
        const previous = seen.has(id) ? seen.get(id) : undefined;
        seen.set(id, stage);
        if (initializedRef.current && previous !== undefined && isWonTransition(previous, stage, currentStages)) {
          centerDealColumn(id, stage);
          announceWin(record, previous);
        }
      }
      for (const id of Array.from(seen.keys())) {
        if (!liveIds.has(id)) seen.delete(id);
      }
      initializedRef.current = true;
    },
    [announceWin, canShowRevenue, centerDealColumn, currentStages],
  );

  useEffect(() => {
    syncWins(deals.items);
  }, [deals.items, syncWins]);

  useEffect(() => {
    const onResourceChanged = (event: Event) => {
      const resource = resourceFromEvent(event);
      if (resource && resource !== "deals") return;
      syncWins(deals.items);
    };
    window.addEventListener("tunaxa:resource-changed", onResourceChanged);
    return () => window.removeEventListener("tunaxa:resource-changed", onResourceChanged);
  }, [deals.items, syncWins]);

  useEffect(
    () => () => {
      if (bannerTimerRef.current !== null) clearTimeout(bannerTimerRef.current);
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (pipelines.loading || pipelines.error) return;
    try {
      localStorage.setItem("tunaxa.pipeline.selected", currentId);
    } catch {
      return;
    }
  }, [currentId, pipelines.loading, pipelines.error]);

  function fieldsFor(definition: PipelineDefinition): FieldSpec[] {
    const labels = Object.create(null) as Record<string, string>;
    for (const stage of definition.stages) labels[stage.key] = stage.label;
    const base: FieldSpec[] = dealFields.map((field) =>
      field.key === "stage"
        ? {
            ...field,
            options: definition.stages.map((stage) => stage.key),
            optionLabels: labels,
          }
        : field,
    );
    const custom = schema.fields.filter(
      (field) =>
        !base.some((baseField) => baseField.key === field.key) &&
        !["pipelineId", "pipeline_id", "probability"].includes(field.key),
    );
    return [...base, ...custom];
  }

  function latestDefinition(snapshot: PipelineDefinition): PipelineDefinition {
    if (!snapshot.id) return LEGACY_PIPELINE;
    const latest = definitions.find((row) => row.id === snapshot.id);
    if (!latest) throw new Error("This pipeline is no longer available. Reload the board.");
    return latest;
  }

  async function persistDeal(
    data: Record<string, unknown>,
    definition: PipelineDefinition,
    rowId?: string,
  ) {
    if (!canEditDeals || dealBusy.current) {
      throw new Error("Deal editing requires member, admin or owner access");
    }
    dealBusy.current = true;
    setSavingDeal(true);
    setMoveError("");
    try {
      const payload = dealPayload(data, latestDefinition(definition));
      const saved = rowId ? await deals.update(rowId, payload) : await deals.create(payload);
      checkDealSave(saved, payload);
      await deals.load();
      setEdit(null);
    } catch (failure) {
      const message = pipelineMoveMessage(failure);
      setMoveError(message);
      toast(message, "error");
      await deals.load();
      throw failure;
    } finally {
      dealBusy.current = false;
      setSavingDeal(false);
    }
  }

  async function moveDeal(row: Row, stage: string) {
    if (!canMoveDeal || !current || dealBusy.current) return;
    if (stageForDeal(row, current)?.key === stage) return;
    setDragging(null);
    setMoveError("");
    dealBusy.current = true;
    setSavingDeal(true);
    try {
      const previousStage = stageForDeal(row, current)?.key;
      const payload = dealPayload({ stage }, latestDefinition(current));
      const saved = await deals.update(row.id, payload);
      checkDealSave(saved, payload);
      await deals.load();
      centerDealColumn(row.id, stage);
      announceWin({ ...row, ...safeDealRecord(saved) }, previousStage);
    } catch (failure) {
      const message = pipelineMoveMessage(failure);
      setMoveError(message);
      toast(message, "error");
      await deals.load();
    } finally {
      dealBusy.current = false;
      setSavingDeal(false);
    }
  }

  async function deleteDeal(id: string) {
    if (!canMoveDeal || !confirm("Delete this deal?")) return;
    try {
      await deals.remove(id);
      await deals.load();
    } catch (failure) {
      const message = pipelineMoveMessage(failure);
      setMoveError(message);
      toast(message, "error");
      await deals.load();
    }
  }

  async function savePipeline(payload: Parameters<typeof pipelines.save>[1]) {
    if (!canConfigure) throw new Error("Pipeline editing requires admin or owner access");
    if (deals.loading || deals.error) {
      throw new Error("Reload the deals before changing a pipeline");
    }
    if (configure) {
      validateStageRemoval(
        latestDefinition(configure),
        payload.stages,
        pipelineDeals(deals.items, configure.id, definitions),
      );
    }
    const saved = await pipelines.save(configure?.id, payload);
    setSelectedId(saved.id);
    setConfigure(undefined);
    setPipelineError("");
    await deals.load();
    toast("Pipeline saved");
  }

  async function setDefaultPipeline(id: string) {
    if (!canConfigure) throw new Error("Pipeline settings require admin or owner access");
    setPipelineError("");
    try {
      await pipelines.setDefault(id);
      toast("Default pipeline updated");
      await deals.load();
    } catch (failure) {
      const message = pipelineMoveMessage(failure);
      setPipelineError(message);
      toast(message, "error");
      throw failure;
    }
  }

  async function deletePipeline(id: string) {
    if (!canConfigure) throw new Error("Pipeline settings require admin or owner access");
    setPipelineError("");
    try {
      await pipelines.remove(id);
      if (selectedId === id) setSelectedId("");
      setConfigure(undefined);
      toast("Pipeline deleted");
      await deals.load();
    } catch (failure) {
      const message = pipelineMoveMessage(failure);
      setPipelineError(message);
      toast(message, "error");
      throw failure;
    }
  }

  const columns = current
    ? current.stages.map((stage) => ({
        ...stage,
        rows: rows.filter((row) => stageForDeal(row, current)?.key === stage.key),
      }))
    : [];
  const unmapped = current ? rows.filter((row) => !stageForDeal(row, current)) : rows;

  function card(row: Row) {
    const stage = current ? stageForDeal(row, current) : undefined;
    return (
      <article
        className="deal-card"
        key={row.id}
        draggable={Boolean(canMoveDeal && current)}
        onDragStart={(event: DragEvent<HTMLElement>) => {
          if (!canMoveDeal || !current) {
            event.preventDefault();
            return;
          }
          setDragging(row.id);
          event.dataTransfer.setData("application/x-tunaxa-deal", row.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => setDragging(null)}
      >
        <div className="deal-top">
          <Badge tone={stage?.probability === 100 ? "green" : "blue"}>
            {stage?.label || row.stage || "Stage unavailable"}
          </Badge>
          {canEditDeals && current ? (
            <div className="row-actions">
              <button
                type="button"
                className="icon-btn tiny"
                aria-label={`Edit ${row.title || "deal"}`}
                disabled={!canMoveDeal}
                onClick={() => setEdit({ row, definition: current })}
              >
                <Icon name="edit" />
              </button>
              <button
                type="button"
                className="icon-btn tiny danger-link"
                aria-label={`Delete ${row.title || "deal"}`}
                disabled={!canMoveDeal}
                onClick={() => void deleteDeal(row.id)}
              >
                <Icon name="trash" />
              </button>
            </div>
          ) : null}
        </div>
        <button type="button" className="deal-title" onClick={() => navigate(`/deals/${encodeURIComponent(row.id)}`)}>
          {row.title || "Untitled deal"}
        </button>
        <p>{row.company || "No company"}</p>
        <strong>{money(row.value || 0)}</strong>
        <footer>
          <span>{row.owner || "Unassigned"}</span>
          <small>{row.closeDate || "No close date"}</small>
        </footer>
        {current ? (
          <label className="pipeline-card-stage">
            <span className="sr-only">Stage for {row.title || "deal"}</span>
            <select
              aria-label={`Move ${row.title || "deal"} to stage`}
              disabled={!canMoveDeal}
              value={stage?.key || ""}
              onChange={(event) => {
                if (event.target.value) void moveDeal(row, event.target.value);
              }}
            >
              {!stage ? <option value="">Choose stage</option> : null}
              {current.stages.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </article>
    );
  }

  return (
    <div className="page pipeline-page">
      <PageHeader
        title="Pipeline"
        description="Choose a pipeline, configure its stages and move deals between them."
      >
        <CsvImportButton
          key={importTarget?.id || currentId || "legacy"}
          resource="deals"
          label="Deals"
          fields={fieldsFor(importPipeline || LEGACY_PIPELINE).map((field) =>
            field.key === "stage"
              ? {
                  ...field,
                  required: false,
                  options: (field.options || []).filter(Boolean),
                }
              : field,
          )}
          onComplete={deals.load}
          onOpenChange={(open) => {
            setImportTarget(open ? current : null);
            setPipelineError("");
          }}
          disabled={!canAddDeal || configure !== undefined || edit !== null}
          unavailable={importUnavailable}
          contextLabel={importPipeline?.name}
          preparePayload={(data) => {
            if (!importPipeline) throw new Error("Choose a pipeline before importing deals");
            return importDealPayload(data, latestDefinition(importPipeline));
          }}
        />
        {canConfigure ? (
          <button
            type="button"
            className="btn secondary"
            disabled={!pipelineReady || savingDeal || pipelines.saving || Boolean(importTarget) || configure !== undefined}
            onClick={() => {
              setPipelineError("");
              setConfigure(null);
            }}
          >
            Create pipeline
          </button>
        ) : null}
        {canAddDeal ? (
          <button type="button" className="btn primary" onClick={() => setEdit({ definition: current! })}>
            <Icon name="plus" /> Add deal
          </button>
        ) : null}
      </PageHeader>
      {canShowRevenue ? <RevenueTicker total={revenue.total} count={revenue.count} /> : null}
      {winBanner ? (
        <div className="win-flash-center-banner" role="status" aria-live="polite">
          <span className="win-flash-center-banner__badge">🎉 Deal won</span>
          <strong className="win-flash-center-banner__title">{winBanner.title}</strong>
          <span className="win-flash-center-banner__transition">{winBanner.transition}</span>
          <span className="win-flash-center-banner__value">{winBanner.value}</span>
        </div>
      ) : null}
      <div className="pipeline-picker">
        <label className="field">
          <span>Pipeline</span>
          <select
            aria-label="Pipeline"
            value={currentId}
            disabled={
              !canEditDeals ||
              pipelines.loading ||
              savingDeal ||
              pipelines.saving ||
              Boolean(importTarget) ||
              edit !== null ||
              configure !== undefined
            }
            onChange={(event) => {
              setDragging(null);
              setSelectedId(event.target.value);
            }}
          >
            {!definitions.length ? <option value="">Default pipeline</option> : null}
            {definitions.map((definition) => (
              <option key={definition.id} value={definition.id}>
                {definition.name}
              </option>
            ))}
            {orphaned.length > 0 || selectedId === ORPHAN_PIPELINE ? (
              <option value={ORPHAN_PIPELINE}>Unassigned pipeline ({orphaned.length})</option>
            ) : null}
          </select>
        </label>
        {canConfigure && current?.id ? (
          <button
            type="button"
            className="btn secondary"
            disabled={!pipelineReady || savingDeal || pipelines.saving || Boolean(importTarget) || deals.loading || Boolean(deals.error)}
            onClick={() => {
              setPipelineError("");
              setConfigure(current);
            }}
          >
            Edit pipeline
          </button>
        ) : null}
        {!canEditDeals ? <span>Read-only access</span> : null}
        <span>
          {rows.length} deals · {money(rows.reduce((sum, row) => sum + (Number(row.value) || 0), 0))}
        </span>
      </div>
      {moveError ? (
        <p className="inline-alert error" role="alert">
          {moveError}
        </p>
      ) : null}
      {pipelineError ? (
        <div className="pipeline-notice" role="alert">
          {pipelineError}
        </div>
      ) : null}
      {pipelines.error ? (
        <div className="pipeline-notice" role="alert">
          <p>{pipelines.error}</p>
          <button type="button" className="btn secondary compact" disabled={pipelines.saving} onClick={() => void pipelines.load()}>
            Retry pipelines
          </button>
        </div>
      ) : null}
      {savingDeal ? <p role="status">Saving deal stage…</p> : null}
      {pipelines.loading || deals.loading ? (
        <p role="status">Loading pipelines and deals…</p>
      ) : deals.error ? (
        <Empty
          icon="pipeline"
          title="Could not load deals"
          text={deals.error}
          action={
            <button type="button" className="btn secondary" onClick={() => void deals.load()}>
              Retry
            </button>
          }
        />
      ) : (
        <>
          {!rows.length ? (
            <Empty
              icon="pipeline"
              title="No deals"
              text="Add your first deal to this pipeline."
              action={
                canAddDeal ? (
                  <button type="button" className="btn primary compact" onClick={() => setEdit({ definition: current! })}>
                    Add deal
                  </button>
                ) : undefined
              }
            />
          ) : null}
          {current && !current.stages.length ? (
            <p role="alert">This pipeline has no stages. Edit the pipeline to add one before creating deals.</p>
          ) : null}
          <div className="pipeline-board">
            {columns.map((stage) => (
              <section
                className={`pipeline-column ${
                  stage.key === flashStage
                    ? "pipeline-column--won-flash animate-win-flash"
                    : ""
                }`.trim()}
                key={stage.key}
                ref={(element) => {
                  if (element) columnRefs.current.set(stage.key, element);
                  else columnRefs.current.delete(stage.key);
                }}
                aria-label={`${stage.label} deals`}
                onDragOver={(event) => {
                  if (canMoveDeal && dragging) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const row = rows.find((item) => item.id === dragging);
                  if (row && event.dataTransfer.getData("application/x-tunaxa-deal") === row.id) {
                    void moveDeal(row, stage.key);
                  }
                }}
              >
                <header>
                  <div>
                    <span className="dot" />
                    <b>{stage.label}</b>
                    <em>{stage.rows.length}</em>
                  </div>
                  <strong>{money(stage.rows.reduce((sum, row) => sum + (Number(row.value) || 0), 0))}</strong>
                </header>
                <p className="pipeline-stage-probability">{stage.probability}% win probability</p>
                <div className="deal-list">
                  {stage.rows.map(card)}
                  {canAddDeal ? (
                    <button
                      type="button"
                      className="add-deal"
                      disabled={!canMoveDeal}
                      onClick={() => setEdit({ row: { id: "", stage: stage.key }, definition: current! })}
                    >
                      <Icon name="plus" /> Add deal
                    </button>
                  ) : null}
                </div>
              </section>
            ))}
            {unmapped.length > 0 ? (
              <section className="pipeline-column pipeline-unmapped" aria-label="Unmapped deals">
                <header>
                  <b>{current ? "Unmapped stages" : "Unassigned pipeline"}</b>
                  <em>{unmapped.length}</em>
                </header>
                <p>
                  {current
                    ? "These deals remain visible. Choose a valid stage to move them onto the board."
                    : "Their stored pipeline is no longer available."}
                </p>
                <div className="deal-list">{unmapped.map(card)}</div>
              </section>
            ) : null}
          </div>
        </>
      )}
      {configure !== undefined ? (
        <PipelineEditor
          initial={configure || undefined}
          occupied={configure ? occupiedStageKeys(pipelineDeals(deals.items, configure.id, definitions), configure) : []}
          busy={pipelines.saving || savingDeal}
          canManage={canConfigure}
          error={pipelineError}
          onClose={() => setConfigure(undefined)}
          onSave={savePipeline}
          onSetDefault={setDefaultPipeline}
          onDelete={deletePipeline}
        />
      ) : null}
      {edit && canEditDeals ? (
        <RecordForm
          key={edit.row?.id || "new"}
          title={`${edit.row?.id ? "Edit" : "Add"} deal`}
          fields={fieldsFor(definitions.find((row) => row.id === edit.definition.id) || edit.definition)}
          initial={{
            ...edit.row,
            stage: edit.row
              ? stageForDeal(edit.row, edit.definition)?.key || ""
              : edit.definition.stages[0]?.key || "",
          }}
          toolbar={
            <p>
              Pipeline: <strong>{edit.definition.name}</strong>
            </p>
          }
          onClose={() => {
            if (!dealBusy.current) setEdit(null);
          }}
          onSave={(data) => persistDeal(data, edit.definition, edit.row?.id)}
        />
      ) : null}
    </div>
  );
}
