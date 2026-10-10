import type { FieldSpec } from "../records/types";

export type CsvResource = "leads" | "contacts" | "companies" | "deals";
export type CsvRow = { rowNumber: number; values: string[]; error?: string };
export type CsvDocument = { headers: string[]; rows: CsvRow[] };
export type PreparedRow = CsvRow & { payload: Record<string, unknown>; errors: string[] };
export type ImportResult = CsvRow & { status: "imported" | "invalid" | "failed" | "unconfirmed" | "not-imported"; reason: string; id?: string };
export const MAX_CSV_ROWS = 1000;
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

export function detectDelimiter(text: string): string {
  const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (char === "\n" || char === "\r") break;
      if (counts.has(char)) counts.set(char, counts.get(char)! + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

export function parseCsv(input: string, delimiter = ","): CsvDocument {
  if (![",", ";", "\t"].includes(delimiter)) throw new Error("Unsupported CSV separator");
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (text.includes("\0")) throw new Error("Choose a UTF-8 CSV text file");
  const records: CsvRow[] = [];
  let cells: string[] = [], value = "", quoted = false, closed = false, line = 1, rowStart = 1;
  const finishRow = () => {
    cells.push(value);
    if (cells.some(cell => cell.trim())) records.push({ rowNumber: rowStart, values: cells });
    cells = []; value = ""; closed = false;
    if (records.length > MAX_CSV_ROWS + 1) throw new Error(`Maximum ${MAX_CSV_ROWS} rows per import`);
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else { value += char; if (char === "\n") line++; }
    } else if (char === delimiter) {
      cells.push(value); value = ""; closed = false;
    } else if (char === "\n") {
      finishRow(); line++; rowStart = line;
    } else if (char === '"') {
      if (closed || value.trim()) throw new Error(`Unexpected quote at CSV line ${line}`);
      value = ""; quoted = true;
    } else if (closed) {
      if (char !== " " && char !== "\t") throw new Error(`Unexpected text after a closing quote at CSV line ${line}`);
    } else value += char;
  }
  if (quoted) throw new Error(`Unclosed quoted value starting at CSV line ${rowStart}`);
  finishRow();
  if (records.length < 2) throw new Error("CSV must contain a header and at least one data row");
  const headers = records[0].values.map(header => header.trim());
  if (headers.some(header => !header)) throw new Error("Every CSV column needs a header");
  return { headers, rows: records.slice(1).map(row => ({ ...row,
    error: row.values.length === headers.length ? undefined : `Expected ${headers.length} columns; found ${row.values.length}` })) };
}

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const protectedFields = new Set(["id", "createdAt", "updatedAt", "workspaceId", "workspace_id", "__proto__", "constructor", "prototype"]);
export function importFields(resource: CsvResource, fields: FieldSpec[]): FieldSpec[] {
  const identity = resource === "deals" ? "title" : "name";
  return fields.filter(field => !protectedFields.has(field.key))
    .map(field => ({ ...field, required: field.key === identity || field.required }));
}

export function guessMapping(headers: string[], fields: FieldSpec[]): string[] {
  const aliases: Record<string, string[]> = {
    name: ["full name", "lead name", "contact name", "company name", "organization"],
    email: ["email address", "e-mail"], phone: ["telephone", "mobile", "phone number"],
    company: ["organization", "company name"], title: ["deal name"], value: ["amount", "deal value"],
  };
  const used = new Set<string>();
  return headers.map(header => {
    const key = normalize(header);
    const match = fields.find(field => !used.has(field.key) && [field.key, field.label].some(name => normalize(name) === key))
      || fields.find(field => !used.has(field.key) && aliases[field.key]?.some(alias => normalize(alias) === key));
    if (match) used.add(match.key);
    return match?.key || "";
  });
}

export function mappingErrors(mapping: string[], fields: FieldSpec[]): string[] {
  const selected = mapping.filter(Boolean);
  const errors: string[] = [];
  if (!selected.length) errors.push("Map at least one column");
  if (new Set(selected).size !== selected.length) errors.push("Each destination property can be mapped only once");
  if (selected.some(key => !fields.some(field => field.key === key))) errors.push("Mapping contains an unavailable property");
  for (const field of fields) if (field.required && !selected.includes(field.key)) errors.push(`Map the required property: ${field.label}`);
  return errors;
}

function convert(value: string, field: FieldSpec): unknown {
  if (field.type === "number") {
    const number = Number(value);
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(number)) throw new Error("must be a valid number (use a decimal point)");
    return number;
  }
  if (field.type === "checkbox") {
    if (["true", "yes", "1"].includes(value.toLowerCase())) return true;
    if (["false", "no", "0"].includes(value.toLowerCase())) return false;
    throw new Error("must be true/false, yes/no or 1/0");
  }
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error("must be a valid email address");
  if (field.type === "date") {
    const date = new Date(value + "T00:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("must be a valid date in YYYY-MM-DD format");
  }
  if (field.type === "select" && field.options?.length) {
    const option = field.options.find(item => item.toLowerCase() === value.toLowerCase() || field.optionLabels?.[item]?.toLowerCase() === value.toLowerCase());
    if (option === undefined) throw new Error(`must be one of: ${field.options.map(item => field.optionLabels?.[item] || item).join(", ")}`);
    return option;
  }
  return value;
}

export function prepareRows(document: CsvDocument, mapping: string[], fields: FieldSpec[]): PreparedRow[] {
  const errors = mappingErrors(mapping, fields);
  if (mapping.length !== document.headers.length) errors.push("Mapping must match the CSV columns");
  if (errors.length) throw new Error(errors.join(". "));
  return document.rows.map(row => {
    const payload: Record<string, unknown> = {};
    const errors = row.error ? [row.error] : [];
    mapping.forEach((key, index) => {
      if (!key) return;
      const field = fields.find(item => item.key === key)!;
      const value = (row.values[index] || "").trim();
      if (!value) {
        if (field.required) errors.push(`${field.label} is required`);
        return;
      }
      try { payload[key] = convert(value, field); }
      catch (error) { errors.push(`${field.label} ${(error as Error).message}`); }
    });
    return { ...row, payload, errors };
  });
}

export async function runCsvImport(rows: PreparedRow[], create: (payload: Record<string, unknown>) => Promise<unknown>,
  onProgress: (results: ImportResult[]) => void = () => {}, shouldStop: () => boolean = () => false): Promise<ImportResult[]> {
  const results: ImportResult[] = rows.map(row => ({ rowNumber: row.rowNumber, values: row.values,
    status: row.errors.length ? "invalid" : "not-imported", reason: row.errors.join("; ") || "Not imported" }));
  let stopReason = "";
  onProgress([...results]);
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].errors.length) continue;
    if (!stopReason && shouldStop()) stopReason = "Stopped by user";
    if (stopReason) { results[index] = { ...results[index], reason: stopReason }; continue; }
    try {
      const saved = await create(rows[index].payload);
      if (!saved || typeof saved !== "object" || !("id" in saved) || typeof saved.id !== "string" || !saved.id || results.some(result => result.id === saved.id)) {
        results[index] = { ...results[index], status: "unconfirmed", reason: "The server did not confirm a record ID. Check the list before importing this row again." };
        stopReason = "Stopped because the previous row could not be confirmed";
      } else results[index] = { ...results[index], status: "imported", id: saved.id, reason: "" };
    } catch (error) {
      const failure = error as { status?: number; message?: string };
      const confirmedRejection = typeof failure.status === "number" && failure.status >= 400 && failure.status < 500 && failure.status !== 408;
      results[index] = { ...results[index], status: confirmedRejection ? "failed" : "unconfirmed",
        reason: confirmedRejection ? failure.message || "Request rejected" : "Save could not be confirmed. Check the list before importing this row again." };
      if (!confirmedRejection || ![400, 409, 422].includes(failure.status!)) stopReason = "Stopped after a request error";
    }
    onProgress([...results]);
  }
  onProgress([...results]);
  return results;
}

export function errorReportCsv(headers: string[], results: ImportResult[]): string {
  const escape = (value: string) => {
    const safe = /^[\s]*[=+\-@]/.test(value) ? "'" + value : value;
    return '"' + safe.replace(/"/g, '""') + '"';
  };
  const issues = results.filter(row => row.status !== "imported");
  const width = Math.max(headers.length, ...issues.map(row => row.values.length));
  const columns = Array.from({ length: width }, (_, index) => headers[index] || `Extra column ${index + 1}`);
  const rows = [["CSV line", "Import status", "Import error", "Record ID", ...columns], ...issues
    .map(row => [String(row.rowNumber), row.status, row.reason, row.id || "", ...columns.map((_, index) => row.values[index] || "")])];
  return "\uFEFF" + rows.map(row => row.map(escape).join(",")).join("\r\n");
}
