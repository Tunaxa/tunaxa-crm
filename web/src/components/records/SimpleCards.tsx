import { type Row } from "./types";
import { type ReactNode } from "react";
import { PageHeader, Empty } from "../ui";
import { Icon } from "../Icon";

export function SimpleCards({
  title,
  description,
  icon,
  items,
  onAdd,
  onEdit,
  onDelete,
  render,
  modal,
  loading = false,
  error,
  onRetry,
  footer,
}: {
  title: string;
  description: string;
  icon: string;
  items: Row[];
  onAdd: () => void;
  onEdit: (row: Row) => void;
  onDelete: (id: string) => void;
  render: (row: Row) => ReactNode;
  modal?: ReactNode;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  footer?: ReactNode;
}) {
  const singular =
    title === "Activities" ? "activity" : title.slice(0, -1).toLowerCase();
  return (
    <div className="page">
      <PageHeader title={title} description={description}>
        <button className="btn primary" onClick={onAdd}>
          <Icon name="plus" /> Add {singular}
        </button>
      </PageHeader>
      {loading ? <p role="status">Loading {title.toLowerCase()}…</p> : error ? (
        <Empty icon={icon} title={`Could not load ${title.toLowerCase()}`} text={error}
          action={onRetry ? <button type="button" className="btn secondary" onClick={onRetry}>Retry</button> : undefined} />
      ) : items.length ? (
        <div className="generic-card-grid">
          {items.map((item) => (
            <article className="surface generic-card" key={item.id}>
              {render(item)}
              <footer>
                <button
                  className="btn secondary compact"
                  onClick={() => onEdit(item)}
                >
                  <Icon name="edit" /> Edit
                </button>
                <button
                  className="btn ghost compact danger-link"
                  onClick={() =>
                    confirm("Delete this record?") && onDelete(item.id)
                  }
                >
                  <Icon name="trash" /> Delete
                </button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon={icon}
          title={`No ${title.toLowerCase()}`}
          text={`Create your first ${singular}.`}
          action={
            <button className="btn primary compact" onClick={onAdd}>
              Add {singular}
            </button>
          }
        />
      )}
      {!loading && !error && footer}
      {modal}
    </div>
  );
}
