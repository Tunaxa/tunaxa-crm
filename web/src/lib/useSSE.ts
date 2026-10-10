import { useEffect, useRef, useState } from "react";
import { api, json } from "./api";

export type SSEStatus = "connected" | "reconnecting" | "disconnected";

export interface SSEEventMap {
  connected: { userId: string };
  "record.created": { resource: string; item: unknown };
  "workflow.created": { id: string };
  "workflow.updated": { id: string };
  "workflow.deleted": { id: string };
  "workflow.graph_saved": { id: string };
  "sequence.enrolled": { sequenceId: string; count: number };
  "sequence.ran": { sequenceId: string } & Record<string, unknown>;
  "integrations.updated": { by?: string; channel?: string };
  "form.submitted": { formId: string; permalink: string; recordId: string };
  "form.created": { id: string };
  "form.updated": { id: string };
  "form.deleted": { id: string };
  "user.role.changed": { userId: string; role: string };
  "user.created": { user: unknown };
  "user.deleted": { userId: string };
  "lifecycle.transitioned": { recordId: string; stage: string };
  "leadscoring.rules_changed": undefined;
  "leadscoring.recalculated": unknown;
  "webhook.created": { id: string };
  "webhook.updated": { id: string };
  "webhook.deleted": { id: string };
  "webhook.received": { endpointId: string; deliveryId: string };
  "ticket.opened": unknown;
  "ticket.updated": unknown;
  "execution.processed": unknown;
}

export type SSEHandlers = {
  [K in keyof SSEEventMap]?: (data: SSEEventMap[K]) => void;
};

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;

function parseData<T>(data: unknown): T | undefined {
  if (data === undefined || data === null || data === "") return undefined;
  try {
    return JSON.parse(String(data)) as T;
  } catch {
    return data as T;
  }
}

export function useSSE(handlers: SSEHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const [status, setStatus] = useState<SSEStatus>("disconnected");
  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<number | null>(null);
  const delayRef = useRef(BASE_DELAY);

  useEffect(() => {
    let disposed = false;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const close = () => {
      esRef.current?.close();
      esRef.current = null;
    };

    const scheduleRetry = () => {
      if (disposed) return;
      setStatus("reconnecting");
      const delay = delayRef.current;
      delayRef.current = Math.min(delay * 2, MAX_DELAY);
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        connect();
      }, delay);
    };

    const connect = async () => {
      if (disposed) return;
      clearTimer();
      close();
      setStatus("reconnecting");

      let token: string;
      try {
        const result = await api<{ token: string }>(
          "/auth/events-token",
          json("POST"),
        );
        token = result.token;
      } catch {
        scheduleRetry();
        return;
      }
      if (disposed) return;

      const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
      esRef.current = es;

      es.onopen = () => {
        if (disposed) return;
        delayRef.current = BASE_DELAY;
        setStatus("connected");
      };

      es.onerror = () => {
        if (disposed) return;
        close();
        scheduleRetry();
      };

      const names = Object.keys(handlersRef.current) as (keyof SSEEventMap)[];
      for (const name of names) {
        es.addEventListener(name, (event) => {
          const handler = handlersRef.current[
            name
          ] as ((data: unknown) => void) | undefined;
          if (!handler) return;
          handler(parseData((event as MessageEvent).data));
        });
      }
    };

    connect();

    return () => {
      disposed = true;
      clearTimer();
      close();
    };
  }, []);

  return { status };
}
