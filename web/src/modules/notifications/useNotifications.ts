import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { notificationError, parseNotificationPage, type NotificationPage } from "./notificationModel";
import { readAllNotifications, readNotification } from "./notificationActions";

export function useNotifications(unreadOnly: boolean, offset: number) {
  const [page, setPage] = useState<NotificationPage | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [writing, setWriting] = useState(false);
  const alive = useRef(true), version = useRef(0), busy = useRef(false), controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (busy.current) return;
    const request = ++version.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setLoading(true);
    try {
      const next = parseNotificationPage(await api(`/notifications?limit=50&offset=${offset}&unreadOnly=${unreadOnly}`, { signal: abort.signal }));
      if (alive.current && request === version.current) { setPage(next); setError(""); }
    } catch (failure) { if (alive.current && request === version.current && !abort.signal.aborted) setError(notificationError(failure)); }
    finally { if (alive.current && request === version.current) setLoading(false); }
  }, [unreadOnly, offset]);
  const latestLoad = useRef(load); latestLoad.current = load;
  useEffect(() => {
    alive.current = true; setPage(null); void load();
    const refresh = () => { if (!document.hidden) void load(); };
    const changed = (event: Event) => { const resource = (event as CustomEvent<{ resource?: string }>).detail?.resource; if (!resource || resource === "notifications") refresh(); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh); window.addEventListener("tunaxa:resource-changed", changed);
    return () => { alive.current = false; version.current++; controller.current?.abort(); window.clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("tunaxa:resource-changed", changed); };
  }, [load]);
  async function write(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true; version.current++; controller.current?.abort(); setLoading(false); setWriting(true);
    let failure = "";
    try { await action(); }
    catch (error) { failure = notificationError(error); }
    finally {
      busy.current = false;
      if (alive.current) { setWriting(false); await latestLoad.current(); if (alive.current && failure) setError(failure); }
    }
  }
  function markRead(id: string) {
    return write(async () => {
      await readNotification(id, api);
    });
  }
  function markAll() {
    return write(async () => {
      await readAllNotifications(api);
    });
  }
  return { page, loading, error, writing, load, markRead, markAll };
}
