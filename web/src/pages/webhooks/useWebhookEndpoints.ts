import { useCallback, useEffect, useRef, useState } from "react";
import { api, json } from "../../lib/api";
import { useSSE } from "../../lib/useSSE";
import {
  confirmedStatus,
  createdEndpoint,
  parseEndpoints,
  webhookError,
  type WebhookEndpoint,
  type webhookPayload,
} from "./webhookModel";

export function useWebhookEndpoints() {
  const [items, setItems] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [writing, setWriting] = useState(false);
  const alive = useRef(true);
  const busy = useRef(false);
  const version = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (busy.current) return;
    const request = ++version.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    try {
      const rows = parseEndpoints(
        await api("/v1/webhooks", { signal: abort.signal }),
      );
      if (alive.current && request === version.current) {
        setItems(rows);
        setError("");
      }
    } catch (failure) {
      if (
        alive.current &&
        request === version.current &&
        !abort.signal.aborted
      ) {
        setError(
          webhookError(failure, "Could not load webhook endpoints. Please retry."),
        );
      }
    } finally {
      if (alive.current && request === version.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      version.current += 1;
      controller.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ resource?: string }>).detail;
      if (!detail?.resource || detail.resource === "webhooks") void load();
    };
    window.addEventListener("tunaxa:resource-changed", onChange);
    return () => window.removeEventListener("tunaxa:resource-changed", onChange);
  }, [load]);

  useSSE({
    "webhook.created": () => void load(),
    "webhook.updated": () => void load(),
    "webhook.deleted": () => void load(),
    "webhook.received": () => void load(),
  });

  async function write<T>(action: () => Promise<T>): Promise<T> {
    if (busy.current) throw new Error("Wait for the current webhook action.");
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

  function create(payload: ReturnType<typeof webhookPayload>) {
    return write(async () => {
      try {
        return createdEndpoint(
          await api("/v1/webhooks", json("POST", payload)),
          payload,
        );
      } catch (failure) {
        throw new Error(
          webhookError(
            failure,
            "Creation could not be confirmed. Refresh and check the endpoint list before trying again.",
          ),
        );
      }
    });
  }

  function setActive(endpoint: WebhookEndpoint) {
    return write(async () => {
      try {
        const saved = confirmedStatus(
          await api(
            `/v1/webhooks/${encodeURIComponent(endpoint.id)}`,
            json("PATCH", { is_active: !endpoint.is_active }),
          ),
          endpoint,
        );
        if (alive.current) {
          setItems((current) =>
            current.map((item) => (item.id === saved.id ? saved : item)),
          );
        }
      } catch (failure) {
        throw new Error(
          webhookError(
            failure,
            "Status update could not be confirmed. Refresh before trying again.",
          ),
        );
      }
    });
  }

  return { items, loading, error, writing, load, create, setActive };
}
