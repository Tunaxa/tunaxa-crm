import { useCallback, useEffect, useRef, useState } from "react";
import { api, json } from "../../../lib/api";
import { assertEmailResponse, deliveryLabel, fetchInbox, inboxError, type EmailPayload, type Message } from "./inboxModel";

export function useInbox() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [writing, setWriting] = useState(false);
  const alive = useRef(true), version = useRef(0), busy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const reading = useRef(new Set<string>());
  const load = useCallback(async () => {
    if (busy.current) return;
    const request = ++version.current;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setLoading(true);
    try {
      const next = await fetchInbox(path => api(path, { signal: abort.signal }));
      if (alive.current && request === version.current) { setMessages(next); setError(""); }
    } catch (failure) {
      if (alive.current && request === version.current && !abort.signal.aborted) setError(inboxError(failure, "Could not load the complete inbox. Refresh before sending or deleting messages."));
    } finally { if (alive.current && request === version.current) setLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true; void load();
    const refresh = (event: Event) => { const resource = (event as CustomEvent<{ resource?: string }>).detail?.resource; if (!resource || resource === "messages") void load(); };
    const focus = () => { void load(); };
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    window.addEventListener("tunaxa:resource-changed", refresh); window.addEventListener("focus", focus);
    return () => { alive.current = false; version.current++; controller.current?.abort(); window.clearInterval(timer); window.removeEventListener("tunaxa:resource-changed", refresh); window.removeEventListener("focus", focus); };
  }, [load]);

  const markRead = useCallback(async (rows: Message[]) => {
    const unread = rows.filter(row => !row.read && !reading.current.has(row.id));
    if (!unread.length) return;
    unread.forEach(row => reading.current.add(row.id));
    let failed = false;
    await Promise.all(unread.map(async row => {
      try {
        const saved = await api<{ id?: string; read?: boolean }>(`/messages/${encodeURIComponent(row.id)}`, json("PATCH", { read: true }));
        if (saved?.id !== row.id || saved.read !== true) throw new Error("Read state not confirmed");
        if (alive.current) setMessages(current => current.map(message => message.id === row.id ? { ...message, read: true } : message));
      } catch { failed = true; }
      finally { reading.current.delete(row.id); }
    }));
    if (alive.current) setReadError(failed ? "Some messages could not be marked read. Retry marking this conversation read." : "");
  }, []);

  async function write<T>(action: () => Promise<T>) {
    if (busy.current) throw new Error("Wait for the current inbox action");
    busy.current = true; version.current++; controller.current?.abort(); setLoading(false); setWriting(true);
    try { return await action(); }
    finally { busy.current = false; if (alive.current) { setWriting(false); await load(); } }
  }
  async function send(payload: EmailPayload) {
    return write(async () => {
      let row: Message;
      try { row = assertEmailResponse(await api("/messages/send", json("POST", payload)), payload); }
      catch (failure) { throw new Error(inboxError(failure, "Send could not be confirmed. Refresh and check the conversation before retrying.")); }
      if (alive.current) setMessages(current => [row, ...current.filter(message => message.id !== row.id)]);
      if (row.status === "Failed") throw new Error(deliveryLabel(row));
      return row;
    });
  }
  async function remove(id: string) {
    return write(async () => {
      try {
        const response = await api<{ ok?: boolean }>(`/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (response?.ok !== true) throw new Error("Delete not confirmed");
        if (alive.current) setMessages(current => current.filter(message => message.id !== id));
      } catch (failure) { throw new Error(inboxError(failure, "Deletion could not be confirmed. Refresh before trying again.")); }
    });
  }
  return { messages, loading, error, readError, writing, load, markRead, send, remove };
}
