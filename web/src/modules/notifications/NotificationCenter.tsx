import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Drawer } from "../../components/ui";
import { notificationTarget } from "../../components/records/urlSecurity";
import { notificationDate, type Notification } from "./notificationModel";
import type { NotificationState } from "./useNotifications";
import "./notifications.css";

export type NotificationDrawerProps = {
  state: NotificationState;
  unreadOnly: boolean;
  onUnreadOnlyChange: (value: boolean) => void;
  offset: number;
  onOffsetChange: (value: number) => void;
  onClose: () => void;
  canManage: boolean;
};

export function NotificationList({
  rows,
  disabled,
  canManage,
  onRead,
  onOpen,
}: {
  rows: Notification[];
  disabled: boolean;
  canManage: boolean;
  onRead: (id: string) => void;
  onOpen: (target: string) => void;
}) {
  return (
    <ul className="notification-list">
      {rows.map((row) => {
        const target = notificationTarget(row.link);
        return (
          <li key={row.id} className={row.read ? "" : "unread"}>
            <div className="notification-heading">
              <strong>{row.title}</strong>
              {!row.read ? <Badge tone="blue">Unread</Badge> : null}
            </div>
            <p>{row.message}</p>
            <time
              dateTime={
                Number.isFinite(Date.parse(row.createdAt))
                  ? row.createdAt
                  : undefined
              }
            >
              {notificationDate(row.createdAt)}
            </time>
            <div className="notification-actions">
              {!row.read && canManage ? (
                <button
                  type="button"
                  className="btn secondary compact"
                  disabled={disabled}
                  onClick={() => onRead(row.id)}
                >
                  Mark read
                </button>
              ) : null}
              {target ? (
                <button
                  type="button"
                  className="btn secondary compact"
                  onClick={() => onOpen(target)}
                >
                  Open record
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function NotificationDrawer({
  state,
  unreadOnly,
  onUnreadOnlyChange,
  offset,
  onOffsetChange,
  onClose,
  canManage,
}: NotificationDrawerProps) {
  const navigate = useNavigate();
  const page = state.page;
  const unavailable = state.loading || state.writing || !!state.error;

  useEffect(() => {
    if (page && offset > 0 && offset >= page.total) {
      onOffsetChange(Math.max(0, Math.ceil(page.total / 50) - 1) * 50);
    }
  }, [page, offset, onOffsetChange]);

  return (
    <Drawer title="Notifications" onClose={onClose}>
      <div className="notification-toolbar">
        <button
          type="button"
          className="btn secondary compact"
          disabled={state.loading || state.writing}
          onClick={() => void state.load()}
        >
          Refresh
        </button>
        {canManage ? (
          <button
            type="button"
            className="btn secondary compact"
            disabled={unavailable || !page?.unreadCount}
            onClick={() => void state.markAll()}
          >
            Mark all read
          </button>
        ) : null}
      </div>
      <div className="notification-toolbar" role="group" aria-label="Notification filters">
        {[false, true].map((value) => (
          <button
            type="button"
            key={String(value)}
            className={`btn ${unreadOnly === value ? "primary" : "secondary"} compact`}
            aria-pressed={unreadOnly === value}
            disabled={state.writing}
            onClick={() => {
              onUnreadOnlyChange(value);
              onOffsetChange(0);
            }}
          >
            {value ? "Unread" : "All"}
          </button>
        ))}
      </div>
      {state.loading ? <p role="status">Loading notifications…</p> : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {page && !state.error ? (
        <>
          <p role="status">
            {page.unreadCount} unread · {page.total}{" "}
            {unreadOnly ? "unread notifications" : "notifications"}
          </p>
          <NotificationList
            rows={page.notifications}
            disabled={unavailable}
            canManage={canManage}
            onRead={(id) => void state.markRead(id)}
            onOpen={(target) => {
              onClose();
              navigate(target);
            }}
          />
          {!page.notifications.length && !state.loading ? (
            <p role="status">
              No {unreadOnly ? "unread " : ""}notifications.
            </p>
          ) : null}
          {page.total > 50 ? (
            <nav className="notification-toolbar" aria-label="Notification pages">
              <button
                type="button"
                className="btn secondary compact"
                disabled={unavailable || offset === 0}
                onClick={() => onOffsetChange(Math.max(0, offset - 50))}
              >
                Previous
              </button>
              <span>Page {Math.floor(offset / 50) + 1}</span>
              <button
                type="button"
                className="btn secondary compact"
                disabled={unavailable || offset + 50 >= page.total}
                onClick={() => onOffsetChange(offset + 50)}
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      ) : null}
    </Drawer>
  );
}
