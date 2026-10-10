import { useEffect, useRef, useState } from "react";
import { api, json } from "../lib/api";
import "./bulkActions.css";

export type BatchResult = { successCount: number; errorCount: number; errors: { id: string; reason: string }[] };
export function failedBatchIds(result: BatchResult, ids: string[]) {
  if (!Number.isInteger(result.successCount) || !Number.isInteger(result.errorCount) || result.successCount < 0 || result.errorCount < 0 || !Array.isArray(result.errors)
    || result.successCount + result.errorCount !== ids.length || result.errors.length !== result.errorCount
    || result.errors.some((error) => !ids.includes(error.id) || typeof error.reason !== "string")
    || new Set(result.errors.map((error) => error.id)).size !== result.errorCount) throw new Error("Unexpected batch response. Reload records before trying again.");
  return result.errors.map((error) => error.id);
}
export function useBulkSelection(scope: string, visibleIds: string[]) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSelected([]); }, [scope]);
  function toggle(id: string) {
    if (busy || !visibleIds.includes(id)) return;
    setSelected((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : ids.length < 100 ? [...ids, id] : ids);
  }
  return { selected, setSelected, busy, setBusy, toggle };
}
export function SelectPage({ ids, selected, onChange, disabled }: { ids: string[]; selected: string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const count = ids.filter((id) => selected.includes(id)).length;
  useEffect(() => { if (input.current) input.current.indeterminate = count > 0 && count < ids.length; }, [count, ids.length]);
  return <input ref={input} type="checkbox" aria-label="Select all visible records" checked={!!ids.length && count === ids.length} disabled={disabled || !ids.length || ids.length > 100}
    onChange={(event) => onChange(event.target.checked ? ids : [])} />;
}
export function BulkActions({ resource, ids, statuses, busy, setBusy, onSelection, onReload }: {
  resource: string; ids: string[]; statuses?: string[]; busy: boolean; setBusy: (busy: boolean) => void;
  onSelection: (ids: string[]) => void; onReload: () => Promise<void>;
}) {
  const [action, setAction] = useState("owner");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const [notice, setNotice] = useState("");
  async function run() {
    if (lock.current || busy || !ids.length) return;
    if (action !== "delete" && !value.trim()) { setError("Choose a value to apply."); return; }
    if (action === "delete" && !window.confirm(`Delete ${ids.length} selected ${resource}? This cannot be undone.`)) return;
    const requestedIds = [...ids];
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await api<BatchResult>(`/${resource}/batch`, json(action === "delete" ? "DELETE" : "PATCH", action === "delete" ? { ids: requestedIds } : { ids: requestedIds, data: { [action]: value.trim() } }));
      const failed = failedBatchIds(response, requestedIds);
      // Retain only failed records so successful actions are not repeated.
      onSelection(failed);
      setNotice(`${response.successCount} records ${action === "delete" ? "deleted" : "updated"}.`);
      if (failed.length) setError(response.errors.map((item) => `${item.id}: ${item.reason}`).join("; "));
      await onReload();
    } catch (failure) { setError((failure as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  if (!ids.length && !notice && !error) return null;
  return <section className="bulk-actions" aria-label="Bulk record actions">
    <strong>{ids.length} selected</strong>
    <label>Action<select disabled={busy} value={action} onChange={(event) => { setAction(event.target.value); setValue(""); setError(""); setNotice(""); }}><option value="owner">Assign Owner</option>{!!statuses?.length && <option value="status">Change Status</option>}<option value="delete">Delete</option></select></label>
    {action === "owner" && <label>Owner<input disabled={busy} value={value} onChange={(event) => setValue(event.target.value)} placeholder="Owner name" /></label>}
    {action === "status" && <label>Status<select disabled={busy} value={value} onChange={(event) => setValue(event.target.value)}><option value="">Choose status</option>{statuses?.map((status) => <option key={status}>{status}</option>)}</select></label>}
    <button type="button" className="btn primary compact" disabled={busy || !ids.length || ids.length > 100} onClick={run}>{busy ? "Applying…" : action === "delete" ? "Delete selected" : "Apply"}</button>
    <button type="button" className="btn ghost compact" disabled={busy} onClick={() => { onSelection([]); setNotice(""); setError(""); }}>Clear selection</button>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
