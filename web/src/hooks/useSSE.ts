import { useCallback, useEffect, useRef, useState } from "react";

type SSEStatus = "idle" | "connecting" | "connected" | "error";

type UseSSEOptions = {
  enabled?: boolean;
  reconnect?: boolean;
  maxRetries?: number;
  baseDelay?: number;
  heartbeatTimeout?: number;
  onMessage?: (event: MessageEvent) => void;
  onError?: (error: Event) => void;
};

type UseSSEReturn = {
  status: SSEStatus;
  error: Event | null;
  reconnect: () => void;
  close: () => void;
};

export function useSSE(
  url: string | null,
  options: UseSSEOptions = {},
): UseSSEReturn {
  const {
    enabled = true,
    reconnect: shouldReconnect = true,
    maxRetries = Infinity,
    baseDelay = 1000,
    heartbeatTimeout = 30000,
    onMessage,
    onError,
  } = options;

  const [status, setStatus] = useState<SSEStatus>("idle");
  const [error, setError] = useState<Event | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    if (heartbeatTimerRef.current !== null) {
      window.clearTimeout(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    clearTimers();

    sourceRef.current?.close();
    sourceRef.current = null;

    setStatus("idle");
  }, [clearTimers]);

  const connect = useCallback(() => {
    if (!url || !enabled) return;

    clearTimers();

    sourceRef.current?.close();

    setStatus("connecting");

    const source = new EventSource(url);
    sourceRef.current = source;

    const resetHeartbeat = () => {
      if (heartbeatTimerRef.current !== null) {
        window.clearTimeout(heartbeatTimerRef.current);
      }

      heartbeatTimerRef.current = window.setTimeout(() => {
        source.close();
        setStatus("error");
      }, heartbeatTimeout);
    };

    source.onopen = () => {
      retryRef.current = 0;
      setError(null);
      setStatus("connected");
      resetHeartbeat();
    };

    source.onmessage = (event) => {
      resetHeartbeat();
      onMessage?.(event);
    };

    source.onerror = (event) => {
      setError(event);
      setStatus("error");
      onError?.(event);

      source.close();

      if (!shouldReconnect || retryRef.current >= maxRetries) {
        return;
      }

      const delay = Math.min(
        baseDelay * 2 ** retryRef.current,
        30000,
      );

      retryRef.current += 1;

      retryTimerRef.current = window.setTimeout(() => {
        connect();
      }, delay);
    };
  }, [
    url,
    enabled,
    shouldReconnect,
    maxRetries,
    baseDelay,
    heartbeatTimeout,
    onMessage,
    onError,
    clearTimers,
  ]);

  const reconnect = useCallback(() => {
    retryRef.current = 0;
    connect();
  }, [connect]);

  useEffect(() => {
    if (!url || !enabled) {
      close();
      return;
    }

    connect();

    return () => {
      clearTimers();
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [url, enabled, connect, close, clearTimers]);

  return {
    status,
    error,
    reconnect,
    close,
  };
}