import { useEffect, useState } from "react";
import { useApp } from "../../context/AppContext";
import { Badge, Drawer, Empty, PageHeader } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { RecordForm } from "../../components/records/RecordForm";
import type { FieldSpec } from "../../components/records/types";
import { allowedStages, filterTickets, isTerminal, ticketSla, type SlaClock, type Ticket } from "./ticketBoard";
import { useTicketBoard } from "./useTicketBoard";
import "./tickets.css";

const fields: FieldSpec[] = [
  { key: "subject", label: "Subject", required: true },
  { key: "contact", label: "Contact name" }, { key: "contactEmail", label: "Contact email", type: "email" },
  { key: "priority", label: "Priority", type: "select", options: ["Low", "Normal", "Medium", "High", "Urgent"] },
  { key: "source", label: "Source", type: "select", options: ["Email", "Phone", "Chat", "Web", "Other"] },
  { key: "description", label: "Description", type: "textarea" },
];
const dateLabel = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Unavailable";
function Clock({ label, value }: { label: string; value: SlaClock }) {
  return <div className={`ticket-sla ticket-sla-${value.state}`}><span>{label}</span><strong title={value.dueAt ? `Due ${dateLabel(value.dueAt)}` : undefined}>{value.label}</strong></div>;
}

export function TicketsPage() {
  const { user, toast } = useApp();
  const { board, loading, refreshing, error, saving, load, move, create } = useTicketBoard();
  const [now, setNow] = useState(Date.now);
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const editable = user?.role === "admin" || user?.role === "member";
  const canMove = editable && !saving && !error && !loading;
  useEffect(() => { const interval = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(interval); }, []);
  const rows = filterTickets(board.data, query, priority, overdueOnly, board.sla, now);
  const overdue = board.data.filter(row => ticketSla(row, board.sla, now).overdue).length;
  const open = board.data.filter(row => !isTerminal(row.stage)).length;
  const selected = board.data.find(row => row.id === selectedId);
  async function changeStage(ticket: Ticket, stage: string) {
    if (!canMove || stage === ticket.stage) return;
    setDragging(null); setTarget("");
    try { await move(ticket, stage); toast("Ticket stage updated"); }
    catch (failure) { toast((failure as Error).message, "error"); }
  }
  function stagePicker(ticket: Ticket) {
    const options = allowedStages(ticket, board.stages);
    return <label className="ticket-stage-picker"><span className="sr-only">Stage for {ticket.subject}</span>
      <select value={ticket.stage} disabled={!canMove || options.length < 2} onChange={event => void changeStage(ticket, event.target.value)}>
        {options.map(stage => <option key={stage} value={stage}>{stage}</option>)}
      </select></label>;
  }
  return <div className="page tickets-page">
    <PageHeader title="Tickets" description="Manage support requests and keep response and resolution targets in view.">
      <button type="button" className="btn secondary" disabled={refreshing || Boolean(saving)} onClick={() => void load()}><Icon name="refresh" />{refreshing ? "Refreshing…" : "Refresh"}</button>
      {editable && <button type="button" className="btn primary" disabled={Boolean(saving) || loading || Boolean(error)} onClick={() => setAdding(true)}><Icon name="plus" />Add ticket</button>}
    </PageHeader>
    {!loading && <div className="ticket-summary"><span><b>{board.total}</b> total</span><span><b>{open}</b> open</span><span><b>{overdue}</b> overdue</span></div>}
    <div className="ticket-filters">
      <label className="field"><span>Search tickets</span><input type="search" value={query} placeholder="Subject, contact or description" onChange={event => setQuery(event.target.value)} /></label>
      <label className="field"><span>Priority</span><select value={priority} onChange={event => setPriority(event.target.value)}><option value="">All priorities</option>{fields.find(field => field.key === "priority")!.options!.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="ticket-overdue-filter"><input type="checkbox" checked={overdueOnly} onChange={event => setOverdueOnly(event.target.checked)} />Overdue only</label>
    </div>
    {saving && <p role="status">{saving === "create" ? "Creating ticket…" : "Saving ticket stage…"}</p>}
    {error && <div className="ticket-load-error" role="alert"><p>{error}</p>{board.data.length > 0 && <p>Showing the last loaded board. Refresh successfully before changing tickets.</p>}<button type="button" className="btn secondary" disabled={refreshing || Boolean(saving)} onClick={() => void load()}>Retry</button></div>}
    {loading ? <p role="status">Loading tickets…</p> : (!error || board.data.length > 0) && <>
      <p className="ticket-help">{rows.length} of {board.total} tickets shown. {editable ? "Drag a card or use its stage selector to move it." : "You have read-only access."}</p>
      {!board.data.length && <Empty icon="ticket" title="No tickets yet" text="Add a support request to start your board." />}
      {board.data.length > 0 && !rows.length && <p role="status">No tickets match these filters.</p>}
      <div className="ticket-board" aria-label="Ticket Kanban board">
        {board.stages.map(stage => {
          const inStage = rows.filter(row => row.stage === stage);
          const dragged = board.data.find(row => row.id === dragging);
          const accepts = Boolean(canMove && dragged && dragged.stage !== stage && allowedStages(dragged, board.stages).includes(stage));
          return <section key={stage} className={`ticket-column ${target === stage && accepts ? "ticket-drop-target" : ""}`} aria-label={`${stage} tickets`}
            onDragOver={event => { if (accepts) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setTarget(stage); } }}
            onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setTarget(""); }}
            onDrop={event => { event.preventDefault(); setTarget(""); if (accepts && dragged && event.dataTransfer.getData("application/x-tunaxa-ticket") === dragged.id) void changeStage(dragged, stage); }}>
            <header><h2>{stage}</h2><span>{inStage.length}</span></header>
            <div className="ticket-column-cards">{inStage.map(ticket => {
              const sla = ticketSla(ticket, board.sla, now);
              return <article key={ticket.id} className={`ticket-card ${sla.overdue ? "ticket-card-overdue" : ""} ${saving === ticket.id ? "ticket-card-saving" : ""}`} draggable={canMove}
                aria-label={ticket.subject} aria-busy={saving === ticket.id}
                onDragStart={event => { if (!canMove) { event.preventDefault(); return; } setDragging(ticket.id); event.dataTransfer.setData("application/x-tunaxa-ticket", ticket.id); event.dataTransfer.effectAllowed = "move"; }}
                onDragEnd={() => { setDragging(null); setTarget(""); }}>
                <div className="ticket-card-top"><Badge tone={ticket.priority === "Urgent" || ticket.priority === "High" ? "red" : "neutral"}>{ticket.priority || "Priority unavailable"}</Badge>{sla.overdue && <span className="ticket-overdue-badge">Overdue</span>}</div>
                <h3><button type="button" className="ticket-title" onClick={() => setSelectedId(ticket.id)}>{ticket.subject}</button></h3>
                <p className="ticket-contact">{ticket.contact || ticket.contactEmail || "No contact"}</p>
                <Clock label="First response" value={sla.first} /><Clock label="Resolution" value={sla.resolution} />
                {stagePicker(ticket)}
              </article>;
            })}{!inStage.length && <p className="ticket-empty-column">No tickets</p>}</div>
          </section>;
        })}
      </div>
    </>}
    {adding && <RecordForm title="Add ticket" fields={fields} initial={{ priority: "Normal", source: "Email" }} onClose={() => { if (!saving) setAdding(false); }} onSave={async data => {
      if (!editable) throw new Error("Ticket creation requires admin or member access");
      await create(data); setAdding(false); toast("Ticket created");
    }} />}
    {selected && <Drawer title={selected.subject} subtitle="Ticket details" onClose={() => setSelectedId(null)}>
      <div className="ticket-details"><div className="field"><span>Stage</span>{stagePicker(selected)}</div>
        <dl>{[["Priority", selected.priority], ["Source", selected.source], ["Contact", selected.contact], ["Email", selected.contactEmail], ["Created", dateLabel(selected.createdAt)], ["First response", dateLabel(selected.firstResponseAt)], ["Resolved", dateLabel(selected.resolvedAt)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "Unavailable"}</dd></div>)}</dl>
        <Clock label="First response" value={ticketSla(selected, board.sla, now).first} /><Clock label="Resolution" value={ticketSla(selected, board.sla, now).resolution} />
        <h3>Description</h3><p className="ticket-description">{selected.description || "No description"}</p>
      </div>
    </Drawer>}
  </div>;
}
