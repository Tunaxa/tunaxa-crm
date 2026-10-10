import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { columnPreferenceKey, readHiddenColumns, visibleColumnKeys, type ColumnOption } from "./columnPreferences";
import "./columnPicker.css";

function read(key: string) {
  try { return readHiddenColumns(window.localStorage, key); } catch { return []; }
}

export function useColumnPreferences(resource: string, userId: string, columns: ColumnOption[]) {
  const key = columnPreferenceKey(resource, userId);
  const [preference, setPreference] = useState(() => ({ key, hidden: read(key) }));
  const [saveError, setSaveError] = useState("");
  const hidden = preference.key === key ? preference.hidden : read(key);
  useEffect(() => {
    setPreference({ key, hidden: read(key) });
    setSaveError("");
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setPreference({ key, hidden: read(key) });
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key]);

  function change(next: string[]) {
    const required = new Set(columns.filter(column => column.required).map(column => column.key));
    const safe = [...new Set(next)].filter(column => !required.has(column));
    setPreference({ key, hidden: safe });
    try {
      window.localStorage.setItem(key, JSON.stringify(safe));
      setSaveError("");
    } catch {
      setSaveError("Your browser could not save these choices. They will apply until you leave this page.");
    }
  }
  return { visibleKeys: visibleColumnKeys(columns, hidden), hidden, change, saveError };
}

export function ColumnPicker({ columns, hidden, onChange, saveError }: {
  columns: ColumnOption[];
  hidden: string[];
  onChange: (hidden: string[]) => void;
  saveError?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 400 });
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); button.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    const reposition = () => setOpen(false);
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  function toggle() {
    const rect = button.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(280, window.innerWidth * 0.85);
      const height = Math.min(400, 112 + columns.length * 36);
      const below = window.innerHeight - rect.bottom - 16;
      const top = below < height && rect.top > below ? Math.max(8, rect.top - height - 8) : rect.bottom + 8;
      setPosition({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), top, maxHeight: Math.max(80, window.innerHeight - top - 8) });
    }
    setOpen(value => !value);
  }

  return <div className="column-picker" ref={root}>
    <button type="button" className="btn secondary compact" ref={button} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={toggle}>Columns</button>
    {open && createPortal(<div id={panelId} ref={panel} style={position} className="column-picker-panel" role="group" aria-label="Visible columns">
      <strong>Visible columns</strong>
      <div className="column-picker-options">
        {columns.map(column => <label key={column.key}>
          <input type="checkbox" checked={!!column.required || !hidden.includes(column.key)} disabled={column.required} onChange={event => onChange(event.target.checked ? hidden.filter(key => key !== column.key) : [...hidden, column.key])} />
          <span>{column.label}{column.required && <small>Always visible</small>}</span>
        </label>)}
      </div>
      {saveError && <p role="alert">{saveError}</p>}
      <div className="column-picker-actions">
        <button type="button" className="btn secondary compact" onClick={() => onChange([])}>Reset</button>
        <button type="button" className="btn primary compact" onClick={() => { setOpen(false); button.current?.focus(); }}>Done</button>
      </div>
    </div>, document.body)}
  </div>;
}
