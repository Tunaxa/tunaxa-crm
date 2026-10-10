import { useCallback, useEffect, useRef, useState } from "react";
import { api, json } from "../../lib/api";
import { boardStages, parseTicket, parseTicketBoard, saveTicketMove, ticketCreatePayload, TICKET_STAGES, type Ticket, type TicketBoard } from "./ticketBoard";

export function useTicketBoard() {
  const [board, setBoard] = useState<TicketBoard>({ data: [], stages: TICKET_STAGES, sla: {}, total: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState("");
  const version = useRef(0);
  const mounted = useRef(true);
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return false;
    const request = ++version.current;
    if (mounted.current) setRefreshing(true);
    try {
      // No page/limit: both the current and upcoming ticket APIs return the full board.
      const next = parseTicketBoard(await api("/tickets"));
      if (!mounted.current || request !== version.current) return false;
      setBoard(next); setError("");
      return true;
    } catch (failure) {
      if (mounted.current && request === version.current) setError((failure as Error).message);
      return false;
    } finally {
      if (mounted.current && request === version.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = (event: Event) => {
      const resource = (event as CustomEvent<{ resource?: string }>).detail?.resource;
      if (!resource || resource === "tickets") void load();
    };
    const focus = () => { void load(); };
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 30000);
    window.addEventListener("tunaxa:resource-changed", refresh);
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false; version.current++;
      window.clearInterval(interval);
      window.removeEventListener("tunaxa:resource-changed", refresh);
      window.removeEventListener("focus", focus);
    };
  }, [load]);
  async function perform(key: string, action: () => Promise<Ticket>) {
    if (busy.current) throw new Error("Wait for the current ticket save");
    busy.current = true; version.current++;
    setSaving(key); setRefreshing(false);
    try {
      const saved = await action();
      if (mounted.current) setBoard(current => {
        const data = [saved, ...current.data.filter(row => row.id !== saved.id)];
        return { ...current, data, total: data.length, stages: boardStages(data, current.stages) };
      });
      return saved;
    } catch (failure) {
      const status = (failure as { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 408) throw failure;
      throw new Error("Save could not be confirmed. Check the refreshed board before trying again.");
    } finally {
      busy.current = false;
      if (mounted.current) { await load(); if (mounted.current) setSaving(""); }
    }
  }
  const move = (ticket: Ticket, stage: string) => perform(ticket.id, () => saveTicketMove(ticket, stage, board.stages,
    payload => api(`/tickets/${encodeURIComponent(ticket.id)}`, json("PUT", payload))));
  const create = (data: Record<string, unknown>) => {
    const payload = ticketCreatePayload(data);
    return perform("create", async () => parseTicket(await api("/tickets", json("POST", payload))));
  };
  return { board, loading, refreshing, error, saving, load, move, create };
}
