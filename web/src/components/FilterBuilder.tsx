import { useState } from "react";
import "./filterBuilder.css";

export type FilterField = { key: string; label: string; type?: string; options?: string[] };
export type FilterCondition = { field: string; operator: string; value?: string | number | boolean };
export type FilterGroup = { $and: FilterCondition[] } | { $or: FilterCondition[] };
type Draft = { id: number; field: string; operator: string; value: string };
export function filterOperators(type?: string) {
  return type === "number" || type === "date" ? ["eq", "neq", "gt", "lt", "is_set"]
    : type === "checkbox" || type === "select" ? ["eq", "neq", "is_set"]
    : ["eq", "neq", "contains", "starts_with", "is_set"];
}
export function buildFilter(rows: Draft[], fields: FilterField[], logic: "AND" | "OR"): FilterGroup | null {
  if (!rows.length) return null;
  const conditions = rows.map((row, index) => {
    const field = fields.find((item) => item.key === row.field);
    if (!field || !filterOperators(field.type).includes(row.operator)) throw new Error(`Choose a valid field and operator for condition ${index + 1}.`);
    if (row.operator === "is_set") return { field: row.field, operator: row.operator };
    if (!row.value.trim()) throw new Error(`Enter a value for condition ${index + 1}.`);
    let value: string | number | boolean = row.value;
    if (field.type === "number") {
      value = Number(row.value);
      if (!Number.isFinite(value)) throw new Error(`Enter a valid number for condition ${index + 1}.`);
    } else if (field.type === "checkbox") {
      if (!["true", "false"].includes(row.value)) throw new Error("Choose Yes or No.");
      value = row.value === "true";
    }
    return { field: row.field, operator: row.operator, value };
  });
  return logic === "AND" ? { $and: conditions } : { $or: conditions };
}
const labels: Record<string, string> = { eq: "Equals", neq: "Does not equal", contains: "Contains", starts_with: "Starts with", gt: "Greater than / after", lt: "Less than / before", is_set: "Has a value" };
export function FilterBuilder({ fields, value, onChange }: { fields: FilterField[]; value: FilterGroup | null; onChange: (value: FilterGroup | null) => void }) {
  const usable = fields.filter((field) => field.type !== "photo");
  const [rows, setRows] = useState<Draft[]>([]);
  const [logic, setLogic] = useState<"AND" | "OR">("AND");
  const [error, setError] = useState("");
  const count = value ? ("$and" in value ? value.$and : value.$or).length : 0;
  function change(id: number, patch: Partial<Draft>) { setRows((list) => list.map((row) => row.id === id ? { ...row, ...patch } : row)); setError(""); }
  return <details className="filter-builder">
    <summary>Advanced filters <span className="filter-count" aria-label={`${count} active filters`}>{count}</span></summary>
    <form onSubmit={(event) => { event.preventDefault(); try { onChange(buildFilter(rows, usable, logic)); setError(""); } catch (failure) { setError((failure as Error).message); } }}>
      <label>Match conditions <select value={logic} onChange={(event) => setLogic(event.target.value as "AND" | "OR")}><option value="AND">All (AND)</option><option value="OR">Any (OR)</option></select></label>
      {rows.map((row, index) => {
        const field = usable.find((item) => item.key === row.field);
        return <div className="filter-condition" key={row.id}>
          <label>Field {index + 1}<select value={row.field} onChange={(event) => change(row.id, { field: event.target.value, operator: "eq", value: "" })}>{usable.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
          <label>Operator {index + 1}<select value={row.operator} onChange={(event) => change(row.id, { operator: event.target.value })}>{filterOperators(field?.type).map((operator) => <option key={operator} value={operator}>{labels[operator]}</option>)}</select></label>
          {row.operator !== "is_set" && <label>Value {index + 1}{field?.type === "checkbox" || field?.type === "select" ? <select value={row.value} onChange={(event) => change(row.id, { value: event.target.value })}><option value="">Choose a value</option>{field.type === "checkbox" ? <><option value="true">Yes</option><option value="false">No</option></> : field.options?.map((option) => <option key={option} value={option}>{option}</option>)}</select>
            : <input type={field?.type === "number" ? "number" : field?.type === "date" ? "date" : "text"} step={field?.type === "number" ? "any" : undefined} value={row.value} onChange={(event) => change(row.id, { value: event.target.value })} />}</label>}
          <button type="button" className="btn ghost compact" aria-label={`Remove condition ${index + 1}`} onClick={() => { setRows((list) => list.filter((item) => item.id !== row.id)); setError(""); }}>Remove</button>
        </div>;
      })}
      {error && <p role="alert">{error}</p>}
      <div className="filter-actions"><button type="button" className="btn secondary compact" disabled={!usable.length || rows.length >= 20} onClick={() => setRows((list) => [...list, { id: Math.max(0, ...list.map((row) => row.id)) + 1, field: usable[0].key, operator: "eq", value: "" }])}>Add condition</button>
        <button type="submit" className="btn primary compact">Apply filters</button>
        <button type="button" className="btn ghost compact" onClick={() => { setRows([]); setLogic("AND"); setError(""); onChange(null); }}>Clear filters</button></div>
    </form>
  </details>;
}
