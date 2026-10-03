import React, { useMemo, useState } from "react";

export interface DataTableColumn<T> {
  key: string;
  label: string;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  width?: number;
}

interface DataTableProps<T> {
  data: T[];
  columns: DataTableColumn<T>[];
  rowKey: (row: T) => string | number;
  pageSize?: number;
  ariaLabel?: string;
  emptyMessage?: string;
}

export function DataTable<T>({
  data,
  columns,
  rowKey,
  pageSize = 10,
  ariaLabel = "Data table",
  emptyMessage = "No records found.",
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

  const handleResize = (
    event: React.MouseEvent,
    column: DataTableColumn<T>,
  ) => {
    event.preventDefault();

    const startX = event.clientX;
    const startWidth =
      sizes[column.key] ||
      (event.currentTarget.parentElement as HTMLElement)?.offsetWidth ||
      160;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(
        80,
        startWidth + moveEvent.clientX - startX,
      );

      setSizes((current) => ({
        ...current,
        [column.key]: newWidth,
      }));
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <div className="data-table-container">
      <div className="overflow-x-auto">
        <table
          className="data-table"
          aria-label={ariaLabel}
        >
          <thead>
            <tr>
              {columns.map((column) => {
                const isSorted = sortKey === column.key;

                return (
                  <th
                    key={column.key}
                    scope="col"
                    style={{
                      width: sizes[column.key]
                        ? `${sizes[column.key]}px`
                        : column.width
                          ? `${column.width}px`
                          : undefined,
                    }}
                  >
                    <div className="data-table-header">
                      <button
                        type="button"
                        onClick={() => handleSort(column)}
                        disabled={column.sortable === false}
                        aria-label={
                          column.sortable === false
                            ? column.label
                            : `Sort by ${column.label}`
                        }
                        aria-sort={
                          isSorted
                            ? sortDirection === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        {column.label}

                        {column.sortable !== false && (
                          <span aria-hidden="true">
                            {isSorted
                              ? sortDirection === "asc"
                                ? " ↑"
                                : " ↓"
                              : " ↕"}
                          </span>
                        )}
                      </button>

                      <span
                        className="data-table-resizer"
                        role="separator"
                        aria-label={`Resize ${column.label} column`}
                        tabIndex={0}
                        onMouseDown={(event) =>
                          handleResize(event, column)
                        }
                      />
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
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
                        : String(
                            row[column.key as keyof T] ?? "—",
                          )}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div
        className="data-table-pagination"
        aria-label="Table pagination"
      >
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
          onClick={() =>
            setPage((current) => Math.min(totalPages, current + 1))
          }
        >
          Next
        </button>
      </div>
    </div>
  );
}