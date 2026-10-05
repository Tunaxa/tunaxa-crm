import { useEffect, useRef, useState } from "react";
import { api, json } from "../lib/api";
import "./duplicateResolution.css";

export type DuplicateRecord = { id: string; [key: string]: unknown };
type Choices = Record<string, "primary" | "secondary">;
const locked = new Set(["id", "workspaceId", "workspace_id", "createdAt", "created_at", "updatedAt", "updated_at", "deletedAt", "deleted_at", "__proto__", "constructor", "prototype"]);
export function duplicateFields(primary: DuplicateRecord, secondary: DuplicateRecord) {
  return [...new Set([...Object.keys(primary), ...Object.keys(secondary)])].filter((key) => !locked.has(key));
}
export function defaultWinner(primary: DuplicateRecord, secondary: DuplicateRecord, key: string): "primary" | "secondary" {
  return (primary[key] === undefined || primary[key] === null || primary[key] === "") && secondary[key] !== undefined ? "secondary" : "primary";
}
export function mergeOverrides(primary: DuplicateRecord, secondary: DuplicateRecord, choices: Choices) {
  return Object.fromEntries(duplicateFields(primary, secondary).map((key) => {
    const side = choices[key] || defaultWinner(primary, secondary, key);
    return [key, (side === "primary" ? primary : secondary)[key]];
  }).filter(([, value]) => value !== undefined));
}
const display = (value: unknown): string => value === undefined ? "Not set" : value === null ? "Empty" : value === "" ? "Blank" : typeof value === "object" ? JSON.stringify(value) : String(value);
const name = (record: DuplicateRecord) => String(record.name || record.email || record.id);
const label = (key: string) => key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");

export function DuplicateResolution({ resource, primaryId, secondaryId, disabled, onMerged, onSkip, onBusyChange }: {
  resource: "contacts" | "companies"; primaryId: string; secondaryId: string; disabled: boolean;
  onMerged: () => void; onSkip: () => void; onBusyChange?: (busy: boolean) => void;
}) {
  const [records, setRecords] = useState<[DuplicateRecord, DuplicateRecord] | null>(null);
  const [choices, setChoices] = useState<Choices>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setRecords(null); setChoices({}); setError(""); setLoading(true);
    Promise.all([primaryId, secondaryId].map((id) => api<DuplicateRecord>(`/${resource}/${encodeURIComponent(id)}`, { signal: controller.signal })))
      .then(([primary, secondary]) => {
        if (primary.id !== primaryId || secondary.id !== secondaryId) throw new Error("Unexpected record response");
        if (!controller.signal.aborted) setRecords([primary, secondary]);
      })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [resource, primaryId, secondaryId, retry]);
  async function merge() {
    if (!records || disabled || lock.current) return;
    const [primary, secondary] = records;
    if (!window.confirm(`Keep ${name(primary)} (${primary.id}) with the selected values and permanently merge/delete ${name(secondary)} (${secondary.id})?`)) return;
    lock.current = true; setBusy(true); onBusyChange?.(true); setError("");
    try {
      const result = await api<{ deletedSecondary: boolean; mergedRecord: DuplicateRecord }>(`/${resource}/merge`, json("POST", {
        primaryId, secondaryId, fieldOverrides: mergeOverrides(primary, secondary, choices),
      }));
      if (result.deletedSecondary !== true || result.mergedRecord?.id !== primaryId) throw new Error("Unexpected merge response. Reload records before trying again.");
      onMerged();
    } catch (failure) { setError((failure as Error).message); }
    finally { lock.current = false; setBusy(false); onBusyChange?.(false); }
  }
  if (loading) return <p role="status">Loading both records…</p>;
  if (!records) return <p role="alert">{error || "Unable to load records."} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></p>;
  const [primary, secondary] = records;
  const overrides = mergeOverrides(primary, secondary, choices);
  return <section className="duplicate-resolution" aria-label="Compare duplicate records">
    <p>Choose which value to keep for each field. Related records move to the surviving record.</p>
    <div className="duplicate-table-scroll"><table>
      <thead><tr><th>Property</th><th scope="col">Keep record: {name(primary)}<small>{primary.id}</small></th><th scope="col">Merge and delete: {name(secondary)}<small>{secondary.id}</small></th><th scope="col">Result</th></tr></thead>
      <tbody>{duplicateFields(primary, secondary).map((key) => <tr key={key}>
        <th scope="row">{label(key)}</th>
        {(["primary", "secondary"] as const).map((side) => <td key={side}><label className="duplicate-value-choice">
          <input type="radio" name={`winner-${key}`} aria-label={`Keep ${label(key)} from ${side === "primary" ? "surviving" : "duplicate"} record`} disabled={disabled || busy || (side === "primary" ? primary : secondary)[key] === undefined}
            checked={(choices[key] || defaultWinner(primary, secondary, key)) === side} onChange={() => setChoices((previous) => ({ ...previous, [key]: side }))} />
          <span>{display((side === "primary" ? primary : secondary)[key])}</span>
        </label></td>)}
        <td>{display(overrides[key])}</td>
      </tr>)}</tbody>
    </table></div>
    {error && <p role="alert">{error}</p>}
    <div className="duplicate-actions"><button type="button" className="btn secondary" disabled={busy} onClick={onSkip}>Skip pair</button>
      <button type="button" className="btn primary" disabled={disabled || busy} onClick={merge}>{busy ? "Merging…" : "Confirm merge"}</button></div>
  </section>;
}
