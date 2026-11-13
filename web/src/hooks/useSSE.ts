import { useCallback, useEffect, useRef, useState } from "react";

export type SSEStatus = "idle" | "connecting" | "connected" | "error";

export type SSECallbacks = {
  onMessage?: (event: MessageEvent) => void;
  onOpen?: () => void;
  onError?: (error: Event) => void;
};

export type UseSSEOptions = SSECallbacks & {
  enabled?: boolean;
  reconnect?: boolean;
  maxRetries?: number;
  baseDelay?: number;
  heartbeatTimeout?: number;
  withCredentials?: boolean;
  /**
   * Optional async URL builder. When supplied it takes precedence over `url`,
   * so callers can exchange a session for a short-lived SSE token
   * (`POST /api/auth/events-token`) before opening the stream.
   */
  getUrl?: () => Promise<string | null>;
};

export type UseSSEReturn = {
  status: SSEStatus;
  error: Event | null;
  reconnect: () => void;
  close: () => void;
};

const MAX_DELAY = 30_000;

type ResolvedOptions = {
  enabled: boolean;
  reconnect: boolean;
  maxRetries: number;
  baseDelay: number;
  heartbeatTimeout: number;
  withCredentials: boolean;
  getUrl?: () => Promise<string | null>;
};

export type SseConnection = {
  start: () => void;
  close: () => void;
  reconnect: () => void;
};

export type SseConnectionDeps = {
  getOptions: () => UseSSEOptions;
  onStatusChange?: (status: SSEStatus) => void;
  onErrorChange?: (error: Event | null) => void;
};

/**
 * Framework-agnostic connection engine behind `useSSE`.
 *
 * Options and callbacks are read lazily through `getOptions`, so updating the
 * callback identities on every render never tears down the socket. The engine
 * is exported so the lifecycle can be unit-tested without a DOM renderer.
 */
export function createSseConnection(
  url: string | null,
  deps: SseConnectionDeps,
): SseConnection {
  const { getOptions, onStatusChange, onErrorChange } = deps;

  let disposed = false;
  let generation = 0;
  let source: EventSource | null = null;
  let retryCount = 0;
  let retryTimer: number | null = null;
  let heartbeatTimer: number | null = null;

  const resolveOptions = (): ResolvedOptions => {
    const options = getOptions();

    return {
      enabled: options.enabled ?? true,
      reconnect: options.reconnect ?? true,
      maxRetries: options.maxRetries ?? Infinity,
      baseDelay: options.baseDelay ?? 1000,
      heartbeatTimeout: options.heartbeatTimeout ?? 30_000,
      withCredentials: options.withCredentials ?? false,
      getUrl: options.getUrl,
    };
  };

  const setStatus = (status: SSEStatus) => {
    if (!disposed) onStatusChange?.(status);
  };

  const setError = (error: Event | null) => {
    if (!disposed) onErrorChange?.(error);
  };

  const clearTimer = (timer: number | null) => {
    if (timer !== null) window.clearTimeout(timer);
    return null;
  };

  const clearRetryTimer = () => {
    retryTimer = clearTimer(retryTimer);
  };

  const clearHeartbeatTimer = () => {
    heartbeatTimer = clearTimer(heartbeatTimer);
  };

  const closeSource = () => {
    const current = source;
    source = null;

    if (!current) return;

    current.onopen = null;
    current.onmessage = null;
    current.onerror = null;
    current.close();
  };

  const scheduleRetry = () => {
    if (disposed) return;

    const options = resolveOptions();
    if (!options.reconnect || retryCount >= options.maxRetries) return;

    const delay = Math.min(options.baseDelay * 2 ** retryCount, MAX_DELAY);
    retryCount += 1;

    clearRetryTimer();
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void open();
    }, delay);
  };

  const startHeartbeat = () => {
    const options = resolveOptions();

    clearHeartbeatTimer();
    heartbeatTimer = window.setTimeout(() => {
      heartbeatTimer = null;
      if (disposed) return;

      closeSource();
      setError(null);
      setStatus("error");
      scheduleRetry();
    }, options.heartbeatTimeout);
  };

  const open = async () => {
    if (disposed) return;

    const options = resolveOptions();
    if (!options.enabled) return;

    // Non-browser runtimes (SSR, test runners, workers) must never throw.
    if (typeof EventSource === "undefined") return;

    const currentGeneration = ++generation;

    let target = url;

    if (options.getUrl) {
      try {
        target = await options.getUrl();
      } catch {
        if (disposed || currentGeneration !== generation) return;
        setStatus("error");
        scheduleRetry();
        return;
      }

      if (disposed || currentGeneration !== generation) return;
    }

    if (!target) {
      setStatus("idle");
      return;
    }

    clearRetryTimer();
    clearHeartbeatTimer();
    closeSource();
    setStatus("connecting");

    const es = new EventSource(target, {
      withCredentials: options.withCredentials,
    });
    source = es;

    es.onopen = () => {
      if (disposed || source !== es) return;

      retryCount = 0;
      setError(null);
      setStatus("connected");
      getOptions().onOpen?.();
      startHeartbeat();
    };

    es.onmessage = (event) => {
      if (disposed || source !== es) return;

      startHeartbeat();
      getOptions().onMessage?.(event);
    };

    es.onerror = (event) => {
      if (disposed || source !== es) return;

      setError(event);
      setStatus("error");
      getOptions().onError?.(event);

      clearHeartbeatTimer();
      closeSource();
      scheduleRetry();
    };
  };

  return {
    start: () => {
      disposed = false;
      void open();
    },
    close: () => {
      disposed = true;
      generation += 1;

      clearRetryTimer();
      clearHeartbeatTimer();
      closeSource();

      onStatusChange?.("idle");
      onErrorChange?.(null);
    },
    reconnect: () => {
      disposed = false;
      retryCount = 0;
      void open();
    },
  };
}

export function useSSE(
  url: string | null,
  options: UseSSEOptions = {},
): UseSSEReturn {
  const { enabled = true } = options;

  const [status, setStatus] = useState<SSEStatus>("idle");
  const [error, setError] = useState<Event | null>(null);

  // Keep the latest options/callbacks without making them effect dependencies.
  // Inline arrow functions therefore never trigger a reconnect.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const connectionRef = useRef<SseConnection | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }

    const connection = createSseConnection(url, {
      getOptions: () => optionsRef.current,
      onStatusChange: setStatus,
      onErrorChange: setError,
    });

    connectionRef.current = connection;
    connection.start();

    return () => {
      connection.close();

      if (connectionRef.current === connection) {
        connectionRef.current = null;
      }
    };
  }, [url, enabled]);

  const reconnect = useCallback(() => {
    connectionRef.current?.reconnect();
  }, []);

  const close = useCallback(() => {
    connectionRef.current?.close();
  }, []);

  return {
    status,
    error,
    reconnect,
    close,
  };
}
