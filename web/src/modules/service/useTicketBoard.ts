import { useCallback, useEffect, useRef, useState } from "react";
import { api, json } from "../../lib/api";
import { boardStages, parseTicket, parseTicketBoard, saveTicketMove, ticketCreatePayload, TICKET_STAGES, type Ticket, type TicketBoard } from "./ticketBoard";

export const TICKET_BOARD_PAGE_SIZE = 100;
export const MAX_BOARD_PAGES = 1000;

type BoardPage = {
  data: unknown[];
  total: number;
  stages?: unknown;
  sla?: unknown;
};

export type TicketFetcher = (path: string) => Promise<unknown>;

function boardPage(value: unknown): BoardPage {
  if (!value || typeof value !== "object") throw new Error("Invalid ticket board response");
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.data) || !Number.isSafeInteger(page.total) || (page.total as number) < 0) throw new Error("Invalid ticket board response");
  return { ...page, data: page.data, total: page.total } as BoardPage;
}

export async function fetchTicketBoard(fetcher: TicketFetcher): Promise<TicketBoard> {
  const first = boardPage(await fetcher(`/tickets?page=1&limit=${TICKET_BOARD_PAGE_SIZE}`));
  const total = first.total;
  const rows = [...first.data];
  let page = 1;
  while (rows.length < total) {
    if (page >= MAX_BOARD_PAGES) throw new Error(`Ticket board exceeds ${MAX_BOARD_PAGES * TICKET_BOARD_PAGE_SIZE} records; refresh before moving tickets.`);
    page += 1;
    const next = boardPage(await fetcher(`/tickets?page=${page}&limit=${TICKET_BOARD_PAGE_SIZE}`));
    if (next.total !== total) throw new Error("Ticket board changed while loading. Refresh before moving tickets.");
    if (!next.data.length) throw new Error("The server returned an incomplete ticket board. Refresh before moving tickets.");
    rows.push(...next.data);
  }
  return parseTicketBoard({ ...first, data: rows, total });
}

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
      const next = await fetchTicketBoard(path => api(path));
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
