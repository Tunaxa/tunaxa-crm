import { useEffect, useState } from "react";
import { api } from "../lib/api";
import "./record360.css";

type RelatedRecord = Record<string, unknown> & { id: string };
type Associations = Record<"companies" | "deals" | "tasks" | "meetings", RelatedRecord[]>;
const empty: Associations = { companies: [], deals: [], tasks: [], meetings: [] };
const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : typeof value === "boolean" ? (value ? "Yes" : "No") : "";
export function openRelatedRecords(items: RelatedRecord[], kind: "deals" | "tasks") {
  const closed = kind === "deals" ? ["won", "lost", "closed", "closed won", "closed lost", "cancelled", "canceled"]
    : ["completed", "complete", "done", "closed", "cancelled", "canceled"];
  return items.filter((item) => kind === "tasks" && item.completed === true ? false
    : ![item.stage, item.status].some((value) => closed.includes(text(value).trim().toLowerCase())));
}
export function associationGroups(data: unknown): Associations {
  if (!data || typeof data !== "object") throw new Error("Invalid associations response");
  const result = {} as Associations;
  for (const group of Object.keys(empty) as (keyof Associations)[]) {
    const rows = (data as Record<string, unknown>)[group];
    if (!Array.isArray(rows)) throw new Error("Invalid associations response");
    result[group] = rows.filter((row) => row && typeof row === "object" && typeof row.id === "string");
  }
  return result;
}

export function AssociationPanel({ title, records }: { title: string; records: RelatedRecord[] }) {
  return <section className="detail-section association-panel" aria-label={title}>
    <h3>{title} <span className="association-count">{records.length}</span></h3>
    {records.length ? records.map((row) => <details key={row.id} className="associated-record">
      <summary>{text(row.name) || text(row.title) || "Related record"}</summary>
      <dl>
        {Object.entries(row).filter(([key, value]) => !["id", "name", "title", "avatar", "logo"].includes(key) && text(value) !== "")
          .map(([key, value]) => <div key={key}><dt>{key.replace(/([A-Z])/g, " $1").replace(/_/g, " ")}</dt><dd>{text(value)}</dd></div>)}
      </dl>
    </details>) : <p className="association-empty">No {title.toLowerCase()}.</p>}
  </section>;
}

export function AssociatedRecords({ contactId, company, name, email }: { contactId: string; company?: string; name?: string; email?: string }) {
  const [data, setData] = useState<Associations>(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(empty); setLoading(true); setError(false);
    api<unknown>(`/contacts/${encodeURIComponent(contactId)}/associations`, { signal: controller.signal })
      .then(associationGroups)
      .then((next) => { if (!controller.signal.aborted) setData(next); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [contactId, company, name, email, retry]);
  if (loading) return <div className="detail-section" role="status">Loading related records…</div>;
  if (error) return <div className="detail-section" role="alert">Could not load related records.
    <button type="button" className="btn secondary compact" onClick={() => setRetry((value) => value + 1)}>Retry</button>
  </div>;
  return <>
    <AssociationPanel title="Associated Company" records={data.companies} />
    <AssociationPanel title="Open Deals" records={openRelatedRecords(data.deals, "deals")} />
    <AssociationPanel title="Open Tasks" records={openRelatedRecords(data.tasks, "tasks")} />
    <AssociationPanel title="Meetings" records={data.meetings} />
  </>;
}
