import { useEffect, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { api, json } from "../../lib/api";
import { Icon } from "../Icon";
import { Drawer } from "../ui";
import type { FieldSpec } from "../records/types";
import { detectDelimiter, errorReportCsv, guessMapping, importFields, mappingErrors, MAX_CSV_BYTES, MAX_CSV_ROWS,
  parseCsv, prepareRows, runCsvImport, type CsvDocument, type CsvResource, type ImportResult } from "./csvImport";
import "./csvImport.css";

const steps = ["Upload", "Map columns", "Preview", "Import", "Error report"];
const statusLabels = { imported: "Imported", invalid: "Invalid", failed: "Rejected", unconfirmed: "Unconfirmed", "not-imported": "Not imported" };
const PREVIEW_SIZE = 10;

type ImportContext = { disabled?: boolean; unavailable?: boolean; contextLabel?: string; preparePayload?: (payload: Record<string, unknown>) => Record<string, unknown> };
export function CsvImportButton({ resource, label, fields, onComplete, onOpenChange, disabled, unavailable, contextLabel, preparePayload }: {
  resource: CsvResource; label: string; fields: FieldSpec[]; onComplete: () => void | Promise<unknown>;
  onOpenChange?: (open: boolean) => void;
} & ImportContext) {
  const { user } = useApp();
  const [open, setOpen] = useState(false);
  const allowed = user?.role === "admin" || user?.role === "member";
  return <>
    <button type="button" className="btn secondary" disabled={!allowed || disabled} title={allowed ? undefined : "Import requires admin or member access"}
      onClick={() => { setOpen(true); onOpenChange?.(true); }}><Icon name="upload" /> Import CSV</button>
    {open && <CsvImportWizard resource={resource} label={label} fields={fields} unavailable={unavailable} contextLabel={contextLabel} preparePayload={preparePayload} onComplete={onComplete} onClose={() => { setOpen(false); onOpenChange?.(false); }} />}
  </>;
}

export function CsvImportWizard({ resource, label, fields, onComplete, onClose, unavailable, contextLabel, preparePayload }: {
  resource: CsvResource; label: string; fields: FieldSpec[];
  onComplete: () => void | Promise<unknown>; onClose: () => void;
} & ImportContext) {
  const { user, toast } = useApp();
  const [step, setStep] = useState(0);
  const [document, setDocument] = useState<CsvDocument | null>(null);
  const [fileName, setFileName] = useState("");
  const [separator, setSeparator] = useState("auto");
  const [mapping, setMapping] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [page, setPage] = useState(1);
  const busy = useRef(false);
  const stopRequested = useRef(false);
  const mounted = useRef(true);
  const fileVersion = useRef(0);
  const allowed = !unavailable && (user?.role === "admin" || user?.role === "member");
  const payloadTransform = useRef(preparePayload);
  payloadTransform.current = preparePayload;
  const access = useRef(allowed);
  access.current = allowed;
  const available = importFields(resource, fields);
  const mappingProblems = mappingErrors(mapping, available);
  const prepared = document && !mappingProblems.length ? prepareRows(document, mapping, available) : [];
  const valid = prepared.filter(row => !row.errors.length);
  const invalid = prepared.length - valid.length;
  const imported = results.filter(row => row.status === "imported").length;
  const issues = results.filter(row => row.status !== "imported");
  const processed = results.filter(row => row.status !== "not-imported").length;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopRequested.current = true; fileVersion.current++; };
  }, []);
  useEffect(() => {
    if (!running) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [running]);

  function close() {
    if (busy.current) { toast("Use Stop after current row and wait for the import result before closing.", "error"); return; }
    fileVersion.current++;
    onClose();
  }
  async function upload(file: File) {
    const version = ++fileVersion.current;
    setError(""); setDocument(null); setReading(true);
    try {
      if (!/\.csv$/i.test(file.name)) throw new Error("Choose a .csv file");
      if (file.size > MAX_CSV_BYTES) throw new Error("Maximum CSV file size is 5 MB");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
      catch { throw new Error("Could not read a UTF-8 CSV file. Save it as CSV UTF-8 and try again."); }
      const parsed = parseCsv(text, separator === "auto" ? detectDelimiter(text) : separator);
      if (version !== fileVersion.current) return;
      setDocument(parsed); setFileName(file.name); setMapping(guessMapping(parsed.headers, available));
      setResults([]); setPage(1); setStep(1);
    } catch (failure) { if (version === fileVersion.current) setError((failure as Error).message); }
    finally { if (version === fileVersion.current) setReading(false); }
  }
  async function run() {
    if (!allowed || !valid.length || busy.current) return;
    busy.current = true; stopRequested.current = false;
    setRunning(true); setStopping(false); setStep(3); setError("");
    try {
      const final = await runCsvImport(prepared, payload => api(`/${resource}`, json("POST", payloadTransform.current ? payloadTransform.current(payload) : payload)),
        next => { if (mounted.current) setResults(next); }, () => stopRequested.current || !access.current);
      if (mounted.current) { setResults(final); setPage(1); setStep(4); }
      window.dispatchEvent(new CustomEvent("tunaxa:resource-changed", { detail: { resource } }));
      try { await onComplete(); }
      catch { if (mounted.current) toast("Import finished, but the list could not refresh. Reload it to see the latest records.", "error"); }
    } finally {
      busy.current = false;
      if (mounted.current) { setRunning(false); setStopping(false); }
    }
  }
  function downloadReport(rows: ImportResult[] = results) {
    if (!document) return;
    const url = URL.createObjectURL(new Blob([errorReportCsv(document.headers, rows)], { type: "text/csv;charset=utf-8" }));
    const link = window.document.createElement("a");
    link.href = url; link.download = `${resource}-import-errors.csv`;
    window.document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const shown = step === 4 ? issues : prepared;
  const totalPages = Math.max(1, Math.ceil(shown.length / PREVIEW_SIZE));
  const visible = shown.slice((page - 1) * PREVIEW_SIZE, page * PREVIEW_SIZE);
  const rowTable = document && <>
    <div className="csv-import-table"><table>
      <caption className="sr-only">{step === 4 ? "Import errors by original CSV line" : "Mapped CSV preview"}</caption>
      <thead><tr><th scope="col">CSV line</th>{document.headers.map((header, index) => <th scope="col" key={index}>
        {header}<small>{available.find(field => field.key === mapping[index])?.label || "Skipped column"}</small>
      </th>)}<th scope="col">{step === 4 ? "Result" : "Validation"}</th></tr></thead>
      <tbody>{visible.map(row => <tr key={row.rowNumber}><th scope="row">{row.rowNumber}</th>
        {document.headers.map((_, index) => <td key={index}>{row.values[index] || "—"}</td>)}
        <td>{"status" in row ? <><strong>{statusLabels[row.status]}</strong><p>{row.reason}</p></>
          : row.errors.length ? <span className="csv-import-error">{row.errors.join("; ")}</span> : "Ready"}</td>
      </tr>)}</tbody>
    </table></div>
    {totalPages > 1 && <nav className="csv-import-pagination" aria-label="CSV preview pagination">
      <button type="button" className="btn secondary compact" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button>
      <span>Page {page} of {totalPages}</span>
      <button type="button" className="btn secondary compact" disabled={page >= totalPages} onClick={() => setPage(value => value + 1)}>Next</button>
    </nav>}
  </>;

  return <Drawer title={`Import ${label}`} subtitle="Upload, map columns, preview and review each row's result." width={960} onClose={close}
    footer={<div className="csv-import-footer">
      {step < 3 && <button type="button" className="btn secondary" onClick={() => { if (step) { setStep(step - 1); setPage(1); } else close(); }}>{step ? "Back" : "Cancel"}</button>}
      {step === 1 && <button type="button" className="btn primary" disabled={Boolean(mappingProblems.length)} onClick={() => { setStep(2); setPage(1); }}>Preview rows</button>}
      {step === 2 && <button type="button" className="btn primary" disabled={!valid.length || !allowed} onClick={run}>Import {valid.length} valid rows</button>}
      {step === 2 && invalid > 0 && <button type="button" className="btn secondary" onClick={() => downloadReport(prepared.filter(row => row.errors.length)
        .map(row => ({ rowNumber: row.rowNumber, values: row.values, status: "invalid", reason: row.errors.join("; ") })))}>Download validation errors</button>}
      {running && <button type="button" className="btn secondary" disabled={stopping} onClick={() => { stopRequested.current = true; setStopping(true); }}>{stopping ? "Stopping after current row…" : "Stop after current row"}</button>}
      {step === 4 && <>
        {issues.length > 0 && <button type="button" className="btn secondary" onClick={() => downloadReport()}>Download error report</button>}
        <button type="button" className="btn primary" disabled={running} onClick={close}>Close</button>
      </>}
    </div>}>
    <div className="csv-import-wizard">
      <ol className="csv-import-steps" aria-label="Import steps">{steps.map((name, index) => <li key={name} aria-current={step === index ? "step" : undefined}><span>{index + 1}</span>{name}</li>)}</ol>
      {contextLabel && <p>Import destination: <strong>{contextLabel}</strong></p>}
      {!allowed && <p role="alert">{unavailable ? "This import destination is unavailable. Close the wizard and refresh the list." : "Import requires admin or member access."}</p>}
      {error && <p className="csv-import-error" role="alert">{error}</p>}
      {step === 0 && <>
        <p>Import creates new records. Existing records are not updated. Choose a UTF-8 CSV file, up to {MAX_CSV_ROWS} rows and 5 MB.</p>
        <label className="field"><span>Column separator</span><select value={separator} disabled={reading} onChange={event => setSeparator(event.target.value)}>
          <option value="auto">Detect automatically</option><option value=",">Comma</option><option value=";">Semicolon</option><option value={"\t"}>Tab</option>
        </select></label>
        <label className="field"><span>CSV file</span><input type="file" accept=".csv,text/csv" disabled={reading || !allowed}
          onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} /></label>
        {reading && <p role="status">Reading CSV…</p>}
      </>}
      {step === 1 && document && <>
        <p>{fileName} · {document.rows.length} data rows. Map each column or choose Skip. Required properties have an asterisk.</p>
        <div className="csv-import-mapping">{document.headers.map((header, index) => <label className="field" key={index}>
          <span>{header} <small>(column {index + 1})</small></span>
          <select value={mapping[index] || ""} onChange={event => setMapping(current => current.map((key, column) => column === index ? event.target.value : key))}>
            <option value="">Skip column</option>{available.map(field => <option key={field.key} value={field.key}>{field.label}{field.required ? " *" : ""}</option>)}
          </select></label>)}</div>
        {mappingProblems.length > 0 && <ul className="csv-import-error" role="alert">{mappingProblems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
      </>}
      {step === 2 && <><p><strong>{valid.length} valid rows</strong> · {invalid} invalid rows. Invalid rows will be skipped and included in the error report.</p>{rowTable}</>}
      {step === 3 && <div role="status" aria-live="polite"><p>{processed} of {prepared.length} rows processed · {imported} confirmed imported</p>
        <progress value={processed} max={prepared.length || 1} aria-label="CSV import progress" />
        <p>{stopping ? "Waiting for the current row's result before stopping." : "Keep this page open until the import finishes."}</p></div>}
      {step === 4 && <>
        <p role="status">{imported} confirmed imported · {issues.length} rows need attention</p>
        <dl className="csv-import-summary">{Object.entries(statusLabels).map(([status, title]) => <div key={status}><dt>{title}</dt><dd>{results.filter(row => row.status === status).length}</dd></div>)}</dl>
        {results.some(row => row.status === "unconfirmed") && <p className="csv-import-error" role="alert">An unconfirmed row may already have been saved. Check the record list before importing it again.</p>}
        {issues.length ? rowTable : <p>All rows were confirmed saved. There are no import errors.</p>}
      </>}
    </div>
  </Drawer>;
}
