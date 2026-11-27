import { useCallback, useEffect, useRef, useState } from "react";
import { hasOwn } from "../../../components/records/urlSecurity";
import { api, json } from "../../../lib/api";
import {
  assertEmailResponse,
  deliveryLabel,
  fetchInbox,
  inboxError,
  type EmailPayload,
  type Message,
} from "./inboxModel";

type ReadEvent = CustomEvent<{ resource?: unknown }>;

function isInboxChange(event: Event): boolean {
  const detail = (event as ReadEvent).detail;
  if (!detail || typeof detail !== "object") return true;
  const resource = detail.resource;
  return resource === undefined || resource === "messages";
}

function confirmedState(value: unknown, id: string, read: boolean): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    hasOwn(row, "id") && row.id === id && hasOwn(row, "read") && row.read === read
  );
}

export function useInbox() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [writing, setWriting] = useState(false);
  const alive = useRef(true);
  const version = useRef(0);
  const busy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(Object.create(null) as Record<string, true>);

  const load = useCallback(async () => {
    if (busy.current) return;
    const request = ++version.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    try {
      const next = await fetchInbox((path) => api(path, { signal: abort.signal }));
      if (alive.current && request === version.current) {
        setMessages(next);
        setError("");
      }
    } catch (failure) {
      if (alive.current && request === version.current && !abort.signal.aborted) {
        setError(
          inboxError(
            failure,
            "Could not load the complete inbox. Refresh before sending or deleting messages.",
          ),
        );
      }
    } finally {
      if (alive.current && request === version.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    const refresh = (event: Event) => {
      if (isInboxChange(event)) void load();
    };
    const focus = () => {
      void load();
    };
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 60_000);
    window.addEventListener("tunaxa:resource-changed", refresh);
    window.addEventListener("focus", focus);
    return () => {
      alive.current = false;
      version.current += 1;
      controller.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener("tunaxa:resource-changed", refresh);
      window.removeEventListener("focus", focus);
    };
  }, [load]);

  const updateReadState = useCallback(async (rows: Message[], read: boolean) => {
    const targets = rows.filter(
      (row) => row.read !== read && !hasOwn(pending.current, row.id),
    );
    if (!targets.length) return;
    targets.forEach((row) => {
      pending.current[row.id] = true;
    });
    let failed = false;
    await Promise.all(
      targets.map(async (row) => {
        try {
          const saved = await api<unknown>(
            `/messages/${encodeURIComponent(row.id)}`,
            json("PATCH", { read }),
          );
          if (!confirmedState(saved, row.id, read)) {
            throw new Error("Read state not confirmed");
          }
          if (alive.current) {
            setMessages((current) =>
              current.map((message) =>
                message.id === row.id ? { ...message, read } : message,
              ),
            );
          }
        } catch {
          failed = true;
        } finally {
          delete pending.current[row.id];
        }
      }),
    );
    if (alive.current) {
      setReadError(
        failed ? "Some messages could not be updated. Retry this conversation." : "",
      );
    }
  }, []);

  const markRead = useCallback(
    (rows: Message[]) => updateReadState(rows, true),
    [updateReadState],
  );
  const markUnread = useCallback(
    (rows: Message[]) => updateReadState(rows, false),
    [updateReadState],
  );

  async function write<T>(action: () => Promise<T>): Promise<T> {
    if (busy.current) throw new Error("Wait for the current inbox action");
    busy.current = true;
    version.current += 1;
    controller.current?.abort();
    setLoading(false);
    setWriting(true);
    try {
      return await action();
    } finally {
      busy.current = false;
      if (alive.current) {
        setWriting(false);
        await load();
      }
    }
  }

  async function send(payload: EmailPayload): Promise<Message> {
    return write(async () => {
      let row: Message;
      try {
        const options = {
          ...json("POST", payload),
          headers: { "Idempotency-Key": payload.idempotencyKey },
        };
        row = assertEmailResponse(
          await api<unknown>("/messages/send", options),
          payload,
        );
      } catch (failure) {
        throw new Error(
          inboxError(
            failure,
            "Send could not be confirmed. Refresh and check the conversation before retrying.",
          ),
        );
      }
      if (alive.current) {
        setMessages((current) => [
          row,
          ...current.filter((message) => message.id !== row.id),
        ]);
      }
      if (row.status === "Failed") throw new Error(deliveryLabel(row));
      return row;
    });
  }

  async function remove(id: string): Promise<void> {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("This message is no longer available. Refresh the inbox.");
    }
    return write(async () => {
      try {
        const response = await api<unknown>(
          `/messages/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        if (
          !response ||
          typeof response !== "object" ||
          Array.isArray(response) ||
          !hasOwn(response, "ok") ||
          (response as Record<string, unknown>).ok !== true
        ) {
          throw new Error("Delete not confirmed");
        }
        if (alive.current) {
          setMessages((current) => current.filter((message) => message.id !== id));
        }
      } catch (failure) {
        throw new Error(
          inboxError(
            failure,
            "Deletion could not be confirmed. Refresh before trying again.",
          ),
        );
      }
    });
  }

  return {
    messages,
    loading,
    error,
    readError,
    writing,
    load,
    markRead,
    markUnread,
    send,
    remove,
  };
}
