import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { ColumnOption } from "./columnPreferences";
import "./columnPicker.css";

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled]):not([hidden]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function portalTarget() {
  if (typeof document === "undefined") return null;
  const body = document.body;
  if (
    !body ||
    typeof (body as unknown as { appendChild?: unknown }).appendChild !==
      "function"
  ) {
    return null;
  }
  return body;
}

export function ColumnPicker({
  columns,
  visibleKeys,
  onChange,
  saveError,
}: {
  columns: ColumnOption[];
  visibleKeys: string[];
  onChange: (visible: string[]) => void;
  saveError?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    maxHeight: 400,
  });
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();

  function place() {
    if (typeof window === "undefined") return;
    const rect = button.current?.getBoundingClientRect?.();
    if (!rect) return;
    const narrow = window.innerWidth <= 768;
    const width = narrow
      ? Math.max(160, window.innerWidth - 16)
      : Math.min(280, window.innerWidth * 0.85);
    const height = Math.min(400, 112 + columns.length * 36);
    const below = window.innerHeight - rect.bottom - 16;
    const top =
      below < height && rect.top > below
        ? Math.max(8, rect.top - height - 8)
        : rect.bottom + 8;
    const left = narrow
      ? 8
      : Math.max(
          8,
          Math.min(rect.right - width, window.innerWidth - width - 8),
        );
    setPosition({
      left,
      top,
      maxHeight: Math.max(80, window.innerHeight - top - 8),
    });
  }

  function close() {
    setOpen(false);
    button.current?.focus?.();
  }

  function toggle() {
    if (open) {
      close();
      return;
    }
    place();
    setOpen(true);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const container = panel.current;
    if (!container || typeof container.querySelectorAll !== "function") {
      return;
    }
    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(FOCUSABLE),
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active =
      typeof document === "undefined"
        ? null
        : (document.activeElement as HTMLElement | null);
    if (event.shiftKey && (active === first || active === container)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  useEffect(() => {
    if (!open) return;
    const firstCheckbox = panel.current?.querySelector?.<HTMLElement>(
      'input[type="checkbox"]:not([disabled]), button:not([disabled])',
    );
    firstCheckbox?.focus?.();
    if (typeof document !== "undefined") {
      const outside = (event: PointerEvent) => {
        const target = event.target as Node;
        if (
          !root.current?.contains?.(target) &&
          !panel.current?.contains?.(target)
        ) {
          close();
        }
      };
      document.addEventListener("pointerdown", outside);
      window.addEventListener("resize", place);
      document.addEventListener("scroll", place, true);
      return () => {
        document.removeEventListener("pointerdown", outside);
        window.removeEventListener("resize", place);
        document.removeEventListener("scroll", place, true);
      };
    }
    if (typeof window !== "undefined") {
      window.addEventListener("resize", place);
      return () => window.removeEventListener("resize", place);
    }
    return;
  }, [open]);

  const mounted = (
    <div
      id={panelId}
      ref={panel}
      style={position}
      className="column-picker-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={handleKeyDown}
    >
      <strong id={titleId}>Visible columns</strong>
      <div className="column-picker-options">
        {columns.map((column) => {
          const checked = !!column.required || visibleKeys.includes(column.key);
          return (
            <label key={column.key}>
              <input
                type="checkbox"
                checked={checked}
                disabled={!!column.required}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...visibleKeys.filter((key) => key !== column.key), column.key]
                      : visibleKeys.filter((key) => key !== column.key),
                  )
                }
              />
              <span>
                {column.label}
                {column.required ? <small>Always visible</small> : null}
              </span>
            </label>
          );
        })}
      </div>
      {saveError ? <p role="alert">{saveError}</p> : null}
      <div className="column-picker-actions">
        <button
          type="button"
          className="btn secondary compact"
          onClick={() => {
            onChange([]);
            close();
          }}
        >
          Reset
        </button>
        <button type="button" className="btn primary compact" onClick={close}>
          Done
        </button>
      </div>
    </div>
  );
  const host = portalTarget();

  return (
    <div className="column-picker" ref={root}>
      <button
        type="button"
        className="btn secondary compact"
        ref={button}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        Columns
      </button>
      {open ? (host ? createPortal(mounted, host) : mounted) : null}
    </div>
  );
}
