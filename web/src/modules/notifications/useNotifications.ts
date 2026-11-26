import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { readAllNotifications, readNotification } from "./notificationActions";
import {
  notificationError,
  parseNotificationPage,
  type NotificationPage,
} from "./notificationModel";

export type NotificationState = {
  page: NotificationPage | null;
  loading: boolean;
  error: string;
  writing: boolean;
  load: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAll: () => Promise<void>;
};

export function useNotifications(
  unreadOnly: boolean,
  offset: number,
  enabled: boolean,
): NotificationState {
  const [page, setPage] = useState<NotificationPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [writing, setWriting] = useState(false);
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    const request = ++requestRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const next = parseNotificationPage(
        await api(
          `/notifications?limit=50&offset=${offset}&unreadOnly=${unreadOnly}`,
          { signal: controller.signal },
        ),
      );
      if (request === requestRef.current) {
        setPage(next);
        setError("");
      }
    } catch (failure) {
      if (request === requestRef.current && !controller.signal.aborted) {
        setError(notificationError(failure));
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [enabled, offset, unreadOnly]);

  useEffect(() => {
    if (!enabled) {
      requestRef.current += 1;
      controllerRef.current?.abort();
      setPage(null);
      setError("");
      setLoading(false);
      return;
    }
    void load();
    return () => controllerRef.current?.abort();
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (!document.hidden) void load();
    };
    const changed = (event: Event) => {
      const resource = (event as CustomEvent<{ resource?: string }>).detail?.resource;
      if (resource === "notifications") refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("tunaxa:resource-changed", changed);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("tunaxa:resource-changed", changed);
    };
  }, [enabled, load]);

  const write = useCallback(
    async (action: () => Promise<unknown>) => {
      setWriting(true);
      try {
        await action();
        await load();
      } catch (failure) {
        setError(notificationError(failure));
      } finally {
        setWriting(false);
      }
    },
    [load],
  );

  const markRead = useCallback(
    (id: string) => write(() => readNotification(id)),
    [write],
  );
  const markAll = useCallback(() => write(() => readAllNotifications()), [write]);

  return { page, loading, error, writing, load, markRead, markAll };
}
