import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CsvImportButton } from "../../components/imports/CsvImportWizard";
import { useResource } from "../../lib/useResource";
import { useApp } from "../../context/AppContext";
import { type Row, type FieldSpec } from "../../components/records/types";
import { useSchema } from "../../components/records/useSchema";
import { PageHeader, money, Badge, Empty } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { RecordForm } from "../../components/records/RecordForm";
import { PipelineEditor } from "./pipelines/PipelineEditor";
import { usePipelineDefinitions } from "./pipelines/usePipelineDefinitions";
import { checkDealSave, dealPayload, importDealPayload, LEGACY_PIPELINE, occupiedStageKeys, ORPHAN_PIPELINE, pipelineDeals, stageForDeal, validateStageRemoval, type PipelineDefinition } from "./pipelines/pipelineDefinitions";
import "./pipelines/pipelines.css";

export function PipelinePage() {
  const deals = useResource<Row>("deals", { all: true });
  const pipelines = usePipelineDefinitions();
  const { user, toast } = useApp();
  const navigate = useNavigate();
  const custom = useSchema("deals");
  const [selectedId, setSelectedId] = useState(() => { try { return localStorage.getItem("tunaxa.pipeline.selected") || ""; } catch { return ""; } });
  const [edit, setEdit] = useState<{ row?: Row; definition: PipelineDefinition } | null>(null);
  const [configure, setConfigure] = useState<PipelineDefinition | null | undefined>(undefined);
  const [dragging, setDragging] = useState<string | null>(null);
  const [savingDeal, setSavingDeal] = useState(false);
  const [importTarget, setImportTarget] = useState<PipelineDefinition | null>(null);
  const dealBusy = useRef(false);
  const definitions = pipelines.definitions;
  const orphaned = definitions.length ? pipelineDeals(deals.items, ORPHAN_PIPELINE, definitions) : [];
  const current = selectedId === ORPHAN_PIPELINE ? null : definitions.find(row => row.id === selectedId) || definitions[0] || LEGACY_PIPELINE;
  const currentId = current?.id || (selectedId === ORPHAN_PIPELINE ? ORPHAN_PIPELINE : "");
  const rows = pipelineDeals(deals.items, currentId, definitions);
  const editable = user?.role === "admin" || user?.role === "member";
  const ready = !pipelines.loading && !pipelines.error;
  const canWrite = editable && !importTarget && !deals.loading && !deals.error && !pipelines.loading && !savingDeal && !pipelines.saving && (!pipelines.error || (pipelines.unavailable && !definitions.length));
  const canAdd = Boolean(canWrite && current?.stages.length);
  const importPipeline = importTarget || current;
  useEffect(() => { if (pipelines.loading || pipelines.error) return; try { localStorage.setItem("tunaxa.pipeline.selected", currentId); } catch { /* Preferences are optional. */ } }, [currentId, pipelines.loading, pipelines.error]);

  function fieldsFor(definition: PipelineDefinition): FieldSpec[] {
    const base: FieldSpec[] = [
      { key: "title", label: "Deal name", required: true }, { key: "company", label: "Company" }, { key: "value", label: "Value", type: "number" },
      { key: "stage", label: "Stage", type: "select", required: true, options: ["", ...definition.stages.map(stage => stage.key)], optionLabels: { "": "Choose stage", ...Object.fromEntries(definition.stages.map(stage => [stage.key, stage.label])) } },
      { key: "owner", label: "Owner" }, { key: "closeDate", label: "Close date", type: "date" },
    ];
    return [...base, ...custom.filter(field => !base.some(item => item.key === field.key) && !["pipelineId", "pipeline_id", "probability"].includes(field.key))];
  }
  function latestDefinition(snapshot: PipelineDefinition) {
    const latest = snapshot.id ? definitions.find(row => row.id === snapshot.id) : LEGACY_PIPELINE;
    if (!latest) throw new Error("This pipeline is no longer available. Reload the board.");
    return latest;
  }
  async function moveDeal(row: Row, stage: string) {
    if (!canWrite || !current || dealBusy.current || stageForDeal(row, current)?.key === stage) return;
    dealBusy.current = true; setSavingDeal(true); setDragging(null);
    try {
      const payload = dealPayload({ stage }, latestDefinition(current));
      const saved = await deals.update(row.id, payload);
      checkDealSave(saved, payload);
    } catch (failure) { toast((failure as Error).message, "error"); await deals.load(); }
    finally { dealBusy.current = false; setSavingDeal(false); }
  }
  const columns = current ? current.stages.map(stage => ({ ...stage, rows: rows.filter(row => stageForDeal(row, current)?.key === stage.key) })) : [];
  const unmapped = current ? rows.filter(row => !stageForDeal(row, current)) : rows;
  function card(row: Row) {
    const stage = current ? stageForDeal(row, current) : undefined;
    return <article className="deal-card" key={row.id} draggable={Boolean(canWrite && current)} onDragStart={event => {
      if (!canWrite || !current) { event.preventDefault(); return; }
      setDragging(row.id); event.dataTransfer.setData("application/x-tunaxa-deal", row.id); event.dataTransfer.effectAllowed = "move";
    }} onDragEnd={() => setDragging(null)}>
      <div className="deal-top"><Badge tone={stage?.probability === 100 ? "green" : "blue"}>{stage?.label || row.stage || "Stage unavailable"}</Badge>
        {editable && current && <div className="row-actions"><button type="button" className="icon-btn tiny" disabled={!canWrite} aria-label={`Edit ${row.title || "deal"}`} onClick={() => setEdit({ row, definition: current })}><Icon name="edit" /></button>
          <button type="button" className="icon-btn tiny danger-link" disabled={!canWrite} aria-label={`Delete ${row.title || "deal"}`} onClick={async () => { if (confirm("Delete this deal?")) { try { await deals.remove(row.id); } catch { /* useResource reports the error. */ } } }}><Icon name="trash" /></button></div>}
      </div>
      <button type="button" className="deal-title" onClick={() => navigate(`/deals/${encodeURIComponent(row.id)}`)}>{row.title || "Untitled deal"}</button>
      <p>{row.company || "No company"}</p><strong>{money(row.value || 0)}</strong>
      <footer><span>{row.owner || "Unassigned"}</span><small>{row.closeDate || "No close date"}</small></footer>
      {current && <label className="pipeline-card-stage"><span className="sr-only">Stage for {row.title || "deal"}</span><select disabled={!canWrite} value={stage?.key || ""} onChange={event => { if (event.target.value) void moveDeal(row, event.target.value); }}>
        {!stage && <option value="">Choose stage</option>}{current.stages.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select></label>}
    </article>;
  }
  return <div className="page pipeline-page">
    <PageHeader title="Pipeline" description="Choose a pipeline, configure its stages and move deals between them.">
      <CsvImportButton key={importTarget ? importTarget.id : currentId} resource="deals" label="Deals" fields={fieldsFor(importPipeline || LEGACY_PIPELINE).map(field => field.key === "stage" ? { ...field, required: false, options: field.options?.filter(Boolean) } : field)} onComplete={deals.load}
        onOpenChange={open => setImportTarget(open ? current : null)} disabled={!canAdd} unavailable={Boolean(!importPipeline || !importPipeline.stages.length || (importTarget?.id && !definitions.some(row => row.id === importTarget.id)) || (pipelines.error && !(pipelines.unavailable && !definitions.length)))} contextLabel={importPipeline?.name} preparePayload={data => importDealPayload(data, latestDefinition(importPipeline!))} />
      {editable && <><button type="button" className="btn secondary" disabled={!ready || savingDeal || pipelines.saving || Boolean(importTarget)} onClick={() => setConfigure(null)}>Create pipeline</button>
        <button type="button" className="btn primary" disabled={!canAdd} onClick={() => setEdit({ definition: current! })}><Icon name="plus" /> Add deal</button></>}
    </PageHeader>
    <div className="pipeline-picker"><label className="field"><span>Pipeline</span><select value={currentId} disabled={pipelines.loading || savingDeal || pipelines.saving || Boolean(importTarget) || edit !== null || configure !== undefined} onChange={event => { setDragging(null); setSelectedId(event.target.value); }}>
      {!definitions.length && <option value="">Default pipeline</option>}{definitions.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      {(orphaned.length > 0 || selectedId === ORPHAN_PIPELINE) && <option value={ORPHAN_PIPELINE}>Unassigned pipeline ({orphaned.length})</option>}
    </select></label>
      {editable && current?.id && <button type="button" className="btn secondary" disabled={!ready || savingDeal || pipelines.saving || Boolean(importTarget) || deals.loading || Boolean(deals.error)} onClick={() => setConfigure(current)}>Edit pipeline</button>}
      {!editable && <span>Read-only access</span>}
      <span>{rows.length} deals · {money(rows.reduce((sum, row) => sum + (Number(row.value) || 0), 0))}</span>
    </div>
    {pipelines.error && <div className="pipeline-notice" role="alert"><p>{pipelines.error}</p><button type="button" className="btn secondary compact" disabled={pipelines.saving} onClick={() => void pipelines.load()}>Retry pipelines</button></div>}
    {savingDeal && <p role="status">Saving deal stage…</p>}
    {pipelines.loading || deals.loading ? <p role="status">Loading pipelines and deals…</p> : deals.error ? <Empty icon="pipeline" title="Could not load deals" text={deals.error} action={<button type="button" className="btn secondary" onClick={() => void deals.load()}>Retry</button>} /> : <>
      {!rows.length && <Empty icon="pipeline" title="No deals" text="Add your first deal to this pipeline." />}
      {current && !current.stages.length && <p role="alert">This pipeline has no stages. Edit the pipeline to add one before creating deals.</p>}
      <div className="pipeline-board">{columns.map(stage => <section className="pipeline-column" key={stage.key} aria-label={`${stage.label} deals`}
        onDragOver={event => { if (canWrite && dragging) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
        onDrop={event => { event.preventDefault(); const row = rows.find(item => item.id === dragging); if (row && event.dataTransfer.getData("application/x-tunaxa-deal") === row.id) void moveDeal(row, stage.key); }}>
        <header><div><span className="dot" /><b>{stage.label}</b><em>{stage.rows.length}</em></div><strong>{money(stage.rows.reduce((sum, row) => sum + (Number(row.value) || 0), 0))}</strong></header>
        <p className="pipeline-stage-probability">{stage.probability}% win probability</p><div className="deal-list">{stage.rows.map(card)}
          {editable && <button type="button" className="add-deal" disabled={!canAdd} onClick={() => setEdit({ row: { id: "", stage: stage.key }, definition: current! })}><Icon name="plus" /> Add deal</button>}
        </div></section>)}
        {unmapped.length > 0 && <section className="pipeline-column pipeline-unmapped" aria-label="Unmapped deals"><header><b>{current ? "Unmapped stages" : "Unassigned pipeline"}</b><em>{unmapped.length}</em></header><p>These deals remain visible. {current ? "Choose a valid stage to move them onto the board." : "Their stored pipeline is no longer available."}</p><div className="deal-list">{unmapped.map(card)}</div></section>}
      </div>
    </>}
    {configure !== undefined && <PipelineEditor initial={configure || undefined} occupied={configure ? occupiedStageKeys(pipelineDeals(deals.items, configure.id, definitions), configure) : []} busy={pipelines.saving} onClose={() => setConfigure(undefined)} onSave={async payload => {
      if (!editable || deals.loading || deals.error) throw new Error("Reload the deals before changing a pipeline");
      if (configure) validateStageRemoval(latestDefinition(configure), payload.stages, pipelineDeals(deals.items, configure.id, definitions));
      const saved = await pipelines.save(configure?.id, payload); setSelectedId(saved.id); setConfigure(undefined); await deals.load(); toast("Pipeline saved");
    }} />}
    {edit && <RecordForm key={edit.row?.id || "new"} title={`${edit.row?.id ? "Edit" : "Add"} deal`} fields={fieldsFor(definitions.find(row => row.id === edit.definition.id) || edit.definition)}
      initial={{ ...edit.row, stage: edit.row ? stageForDeal(edit.row, edit.definition)?.key || "" : edit.definition.stages[0]?.key || "" }} toolbar={<p>Pipeline: <strong>{edit.definition.name}</strong></p>}
      onClose={() => { if (!dealBusy.current) setEdit(null); }} onSave={async data => {
        if (!editable || dealBusy.current) throw new Error("Deal editing requires admin or member access");
        dealBusy.current = true; setSavingDeal(true);
        try { const payload = dealPayload(data, latestDefinition(edit.definition)); const saved = edit.row?.id ? await deals.update(edit.row.id, payload) : await deals.create(payload); checkDealSave(saved, payload); setEdit(null); }
        finally { dealBusy.current = false; setSavingDeal(false); }
      }} />}
  </div>;
}
