import React, { useEffect, useMemo, useRef, useState } from "react";

export interface DataTableColumn<T> {
  key: string;
  label: string;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  width?: number;
}

export interface DataTableProps<T> {
  data: T[];
  columns: DataTableColumn<T>[];
  rowKey: (row: T) => string | number;
  pageSize?: number;
  ariaLabel?: string;
  emptyMessage?: string;
  loading?: boolean;
}

const DEFAULT_COLUMN_WIDTH = 160;
const MIN_COLUMN_WIDTH = 80;
const MAX_COLUMN_WIDTH = 600;
const KEYBOARD_RESIZE_STEP = 16;
const KEYBOARD_RESIZE_STEP_LARGE = 48;

function clampWidth(width: number): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}

export function DataTable<T>({
  data,
  columns,
  rowKey,
  pageSize = 10,
  ariaLabel = "Data table",
  emptyMessage = "No records found.",
  loading = false,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [sizes, setSizes] = useState<Record<string, number>>(
    Object.fromEntries(
      columns
        .filter((column) => column.width)
        .map((column) => [column.key, column.width!]),
    ),
  );

  // Active drag listeners live in a ref so unmounting mid-drag can detach them
  // instead of leaving document-level handlers behind.
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    },
    [],
  );

  const sortedData = useMemo(() => {
    if (!sortKey) return data;

    return [...data].sort((a, b) => {
      const first = a[sortKey as keyof T];
      const second = b[sortKey as keyof T];

      if (first == null) return 1;
      if (second == null) return -1;

      const result = String(first).localeCompare(String(second), undefined, {
        numeric: true,
        sensitivity: "base",
      });

      return sortDirection === "asc" ? result : -result;
    });
  }, [data, sortKey, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedData.length / pageSize));

  const currentPage = Math.min(page, totalPages);

  const visibleRows = sortedData.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  const columnWidth = (column: DataTableColumn<T>) =>
    clampWidth(sizes[column.key] ?? column.width ?? DEFAULT_COLUMN_WIDTH);

  /** `aria-sort` belongs on the column header, never on the inner button. */
  const ariaSortFor = (
    column: DataTableColumn<T>,
  ): React.AriaAttributes["aria-sort"] => {
    if (column.sortable === false) return undefined;
    if (sortKey !== column.key) return "none";
    return sortDirection === "asc" ? "ascending" : "descending";
  };

  const handleSort = (column: DataTableColumn<T>) => {
    if (column.sortable === false) return;

    if (sortKey === column.key) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(column.key);
      setSortDirection("asc");
    }

    setPage(1);
  };

  const handleResizeStart = (
    event: React.MouseEvent<HTMLSpanElement>,
    column: DataTableColumn<T>,
  ) => {
    event.preventDefault();

    // A previous drag that never saw mouseup must not keep its listeners.
    dragCleanupRef.current?.();

    const startX = event.clientX;
    const startWidth = columnWidth(column);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      setSizes((current) => ({
        ...current,
        [column.key]: clampWidth(startWidth + moveEvent.clientX - startX),
      }));
    };

    const cleanup = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", cleanup);
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current = cleanup;
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", cleanup);
  };

  const handleResizeKeyDown = (
    event: React.KeyboardEvent<HTMLSpanElement>,
    column: DataTableColumn<T>,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

    event.preventDefault();

    const step = event.shiftKey
      ? KEYBOARD_RESIZE_STEP_LARGE
      : KEYBOARD_RESIZE_STEP;
    const delta = event.key === "ArrowRight" ? step : -step;

    setSizes((current) => ({
      ...current,
      [column.key]: clampWidth(
        (current[column.key] ?? column.width ?? DEFAULT_COLUMN_WIDTH) + delta,
      ),
    }));
  };

  return (
    <div className="data-table-container">
      <div className="overflow-x-auto">
        <table
          className="data-table"
          aria-label={ariaLabel}
          aria-busy={loading || undefined}
        >
          <thead>
            <tr>
              {columns.map((column) => {
                const isSorted = sortKey === column.key;
                const sortable = column.sortable !== false;

                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={ariaSortFor(column)}
                    style={{ width: `${columnWidth(column)}px` }}
                  >
                    <div className="data-table-header">
                      {sortable ? (
                        <button
                          type="button"
                          className="data-table-sort-btn"
                          onClick={() => handleSort(column)}
                          aria-label={`Sort by ${column.label}`}
                        >
                          {column.label}

                          <span aria-hidden="true">
                            {isSorted
                              ? sortDirection === "asc"
                                ? " ↑"
                                : " ↓"
                              : " ↕"}
                          </span>
                        </button>
                      ) : (
                        <span className="data-table-sort-label">
                          {column.label}
                        </span>
                      )}

                      <span
                        className="data-table-resizer"
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${column.label} column`}
                        aria-valuenow={columnWidth(column)}
                        aria-valuemin={MIN_COLUMN_WIDTH}
                        aria-valuemax={MAX_COLUMN_WIDTH}
                        tabIndex={0}
                        onMouseDown={(event) =>
                          handleResizeStart(event, column)
                        }
                        onKeyDown={(event) =>
                          handleResizeKeyDown(event, column)
                        }
                      />
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {loading && data.length === 0 ? (
              <tr>
                <td className="data-table-empty" colSpan={columns.length}>
                  Loading…
                </td>
              </tr>
            ) : visibleRows.length === 0 ? (
              <tr>
                <td className="data-table-empty" colSpan={columns.length}>
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              visibleRows.map((row) => (
                <tr key={rowKey(row)}>
                  {columns.map((column) => (
                    <td key={column.key}>
                      {column.render
                        ? column.render(row)
                        : String(row[column.key as keyof T] ?? "—")}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <nav className="data-table-pagination" aria-label="Table pagination">
        <button
          type="button"
          disabled={currentPage <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          Previous
        </button>

        <span aria-live="polite">
          Page {currentPage} of {totalPages}
        </span>

        <button
          type="button"
          disabled={currentPage >= totalPages}
          onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
        >
          Next
        </button>
      </nav>
    </div>
  );
}
