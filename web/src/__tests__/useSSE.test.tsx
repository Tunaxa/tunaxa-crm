import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSseConnection,
  useSSE,
  type SSEStatus,
  type UseSSEOptions,
} from "../hooks/useSSE";

class MockEventSource {
  static instances: MockEventSource[] = [];

  static reset() {
    MockEventSource.instances = [];
  }

  readonly url: string;
  readonly init?: EventSourceInit;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.init = init;
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emitOpen() {
    this.onopen?.(new Event("open"));
  }

  emitMessage(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  emitError() {
    this.onerror?.(new Event("error"));
  }
}

const originalWindow = (globalThis as { window?: unknown }).window;
const originalEventSource = (globalThis as { EventSource?: unknown })
  .EventSource;

function latestSource(): MockEventSource {
  const source = MockEventSource.instances[MockEventSource.instances.length - 1];
  if (!source) throw new Error("no EventSource was opened");
  return source;
}

function setup(url: string | null = "/api/events?token=test") {
  let current: UseSSEOptions = {};
  const statuses: SSEStatus[] = [];

  const connection = createSseConnection(url, {
    getOptions: () => current,
    onStatusChange: (status) => statuses.push(status),
  });

  return {
    connection,
    statuses,
    // Mirrors what the hook's options ref does on every render.
    setOptions: (next: UseSSEOptions) => {
      current = next;
    },
    latestSource,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  MockEventSource.reset();
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("createSseConnection", () => {
  it("opens exactly one EventSource on start", () => {
    const harness = setup();

    harness.connection.start();

    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("does not reconnect when callback identities change on re-render", () => {
    const previousMessages: string[] = [];
    const nextMessages: string[] = [];
    const harness = setup();

    harness.setOptions({
      onMessage: (event) => previousMessages.push(String(event.data)),
    });
    harness.connection.start();

    const source = harness.latestSource();
    source.emitOpen();

    // Simulate a parent re-render that passes fresh inline arrow functions.
    harness.setOptions({
      onMessage: (event) => nextMessages.push(String(event.data)),
      onError: () => undefined,
    });
    harness.setOptions({
      onMessage: (event) => nextMessages.push(String(event.data)),
      onError: () => undefined,
    });

    source.emitMessage("tick");

    expect(MockEventSource.instances).toHaveLength(1);
    expect(nextMessages).toEqual(["tick"]);
    expect(previousMessages).toEqual([]);
  });

  it("does not open a connection when the url is null", () => {
    const harness = setup(null);

    harness.connection.start();

    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("does not open a connection when disabled", () => {
    const harness = setup();
    harness.setOptions({ enabled: false });

    harness.connection.start();

    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("passes withCredentials through to the EventSource", () => {
    const harness = setup();
    harness.setOptions({ withCredentials: true });

    harness.connection.start();

    expect(harness.latestSource().init).toEqual({ withCredentials: true });
  });

  it("resolves an async getUrl before opening the stream", async () => {
    const harness = setup(null);
    harness.setOptions({
      getUrl: async () => "/api/events?token=exchanged",
    });

    harness.connection.start();
    expect(MockEventSource.instances).toHaveLength(0);

    await flushMicrotasks();

    expect(harness.latestSource().url).toBe("/api/events?token=exchanged");
  });

  it("recovers from a heartbeat timeout by closing and reconnecting", () => {
    const harness = setup();
    harness.setOptions({ heartbeatTimeout: 1000, baseDelay: 500 });
    harness.connection.start();

    const stalled = harness.latestSource();
    stalled.emitOpen();
    expect(harness.statuses).toContain("connected");

    vi.advanceTimersByTime(1000);

    expect(stalled.closed).toBe(true);
    expect(harness.statuses[harness.statuses.length - 1]).toBe("error");
    expect(MockEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(500);

    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("applies exponential backoff and stops at maxRetries", () => {
    const harness = setup();
    harness.setOptions({
      maxRetries: 2,
      baseDelay: 100,
      heartbeatTimeout: 100_000,
    });
    harness.connection.start();

    expect(MockEventSource.instances).toHaveLength(1);
    harness.latestSource().emitError();

    // First retry waits baseDelay (100ms).
    vi.advanceTimersByTime(99);
    expect(MockEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(2);

    // Second retry waits 2x baseDelay (200ms).
    harness.latestSource().emitError();
    vi.advanceTimersByTime(199);
    expect(MockEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(3);

    // Retry budget exhausted: further errors must not reconnect.
    harness.latestSource().emitError();
    vi.advanceTimersByTime(100_000);
    expect(MockEventSource.instances).toHaveLength(3);
  });

  it("closes the socket and clears every timer on close", () => {
    const harness = setup();
    harness.setOptions({ heartbeatTimeout: 1000, baseDelay: 500 });
    harness.connection.start();

    const source = harness.latestSource();
    source.emitOpen();
    source.emitError();

    expect(vi.getTimerCount()).toBeGreaterThan(0);

    harness.connection.close();

    expect(source.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.statuses[harness.statuses.length - 1]).toBe("idle");
  });

  it("does not throw when EventSource is unavailable", async () => {
    delete (globalThis as { EventSource?: unknown }).EventSource;
    const harness = setup();

    expect(() => harness.connection.start()).not.toThrow();
    await flushMicrotasks();

    expect(MockEventSource.instances).toHaveLength(0);
  });
});

describe("useSSE server rendering", () => {
  it("renders without throwing when EventSource is unavailable", () => {
    delete (globalThis as { EventSource?: unknown }).EventSource;

    function Harness() {
      useSSE("/api/events?token=test");
      return null;
    }

    expect(() => renderToStaticMarkup(<Harness />)).not.toThrow();
  });
});
