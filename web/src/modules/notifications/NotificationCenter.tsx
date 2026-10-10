import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../../components/Icon";
import { Badge, Drawer } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import { notificationDate, notificationTarget, type Notification } from "./notificationModel";
import { useNotifications } from "./useNotifications";
import "./notifications.css";

export function NotificationList({ rows, disabled, onRead, onOpen }: { rows: Notification[]; disabled: boolean; onRead: (id: string) => void; onOpen: (target: string) => void }) {
  return <ul className="notification-list">{rows.map(row => {
    const target = notificationTarget(row.link);
    return <li key={row.id} className={row.read ? "" : "unread"}>
      <div className="notification-heading"><strong>{row.title}</strong>{!row.read && <Badge tone="blue">Unread</Badge>}</div>
      <p>{row.message}</p><time dateTime={Number.isFinite(Date.parse(row.createdAt)) ? row.createdAt : undefined}>{notificationDate(row.createdAt)}</time>
      <div className="notification-actions">{!row.read && <button type="button" className="btn secondary compact" disabled={disabled} onClick={() => onRead(row.id)}>Mark read</button>}
        {target && <button type="button" className="btn secondary compact" onClick={() => onOpen(target)}>Open record</button>}
      </div>
    </li>;
  })}</ul>;
}
function UserNotificationCenter() {
  const [open, setOpen] = useState(false), [unreadOnly, setUnreadOnly] = useState(false), [offset, setOffset] = useState(0);
  const state = useNotifications(unreadOnly, offset), navigate = useNavigate();
  const page = state.page, unavailable = state.loading || state.writing || !!state.error;
  useEffect(() => { if (page && offset > 0 && offset >= page.total) setOffset(Math.max(0, Math.ceil(page.total / 50) - 1) * 50); }, [page, offset]);
  return <>
    <button type="button" className="icon-btn notification-btn notification-trigger" aria-label={state.error ? "Notifications unavailable" : page ? `Notifications, ${page.unreadCount} unread` : "Notifications"} aria-haspopup="dialog" aria-expanded={open} title="Notifications" onClick={() => { setOpen(true); void state.load(); }}>
      <Icon name="bell" />{page && !state.error && page.unreadCount > 0 && <span className="notification-count" aria-hidden="true">{page.unreadCount > 99 ? "99+" : page.unreadCount}</span>}
    </button>
    {open && <Drawer title="Notifications" onClose={() => setOpen(false)}>
      <div className="notification-toolbar"><button type="button" className="btn secondary compact" disabled={state.loading || state.writing} onClick={() => void state.load()}>Refresh</button>
        <button type="button" className="btn secondary compact" disabled={unavailable || !page?.unreadCount} onClick={() => void state.markAll()}>Mark all read</button></div>
      <div className="notification-toolbar" role="group" aria-label="Notification filters">{[false, true].map(value => <button type="button" key={String(value)} className={`btn ${unreadOnly === value ? "primary" : "secondary"} compact`} aria-pressed={unreadOnly === value} disabled={state.writing} onClick={() => { setUnreadOnly(value); setOffset(0); }}>{value ? "Unread" : "All"}</button>)}</div>
      {state.loading && <p role="status">Loading notifications…</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {page && !state.error && <>
        <p>{page.unreadCount} unread · {page.total} {unreadOnly ? "unread notifications" : "notifications"}</p>
        <NotificationList rows={page.notifications} disabled={unavailable} onRead={id => void state.markRead(id)} onOpen={target => { setOpen(false); navigate(target); }} />
        {!page.notifications.length && !state.loading && <p>No {unreadOnly ? "unread " : ""}notifications.</p>}
        {page.total > 50 && <nav className="notification-toolbar" aria-label="Notification pages"><button type="button" className="btn secondary compact" disabled={unavailable || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous</button><span>Page {Math.floor(offset / 50) + 1}</span><button type="button" className="btn secondary compact" disabled={unavailable || offset + 50 >= page.total} onClick={() => setOffset(value => value + 50)}>Next</button></nav>}
      </>}
    </Drawer>}
  </>;
}
export function NotificationCenter() {
  const { user } = useApp();
  return user ? <UserNotificationCenter key={user.id} /> : null;
}
