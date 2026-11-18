import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineBanner } from "./OfflineBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Listener = () => void;

const mounted: ReactTestRenderer[] = [];
let listeners: Record<"online" | "offline", Set<Listener>>;
let dispatchEvent: ReturnType<typeof vi.fn>;

class TestCustomEvent {
  readonly type: string;

  constructor(type: string) {
    this.type = type;
  }
}

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(OfflineBanner));
  });
  mounted.push(renderer);
  return renderer;
}

function emit(type: "online" | "offline") {
  act(() => {
    listeners[type].forEach((listener) => listener());
  });
}

beforeEach(() => {
  listeners = { online: new Set(), offline: new Set() };
  dispatchEvent = vi.fn();

  vi.stubGlobal("CustomEvent", TestCustomEvent);
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: Listener) => {
      if (type === "online" || type === "offline") listeners[type].add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => {
      if (type === "online" || type === "offline") listeners[type].delete(listener);
    },
    dispatchEvent,
  });
});

afterEach(() => {
  while (mounted.length) {
    const renderer = mounted.pop()!;
    act(() => renderer.unmount());
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OfflineBanner", () => {
  it("renders nothing while the browser is online", () => {
    const renderer = mount();

    expect(renderer.toJSON()).toBeNull();
  });

  it("renders the banner, live status, and Retry button when offline", () => {
    vi.stubGlobal("navigator", { onLine: false });

    const renderer = mount();

    expect(renderer.toJSON()).not.toBeNull();
    const region = renderer.root.findByProps({
      role: "region",
      "aria-label": "Connectivity status",
    });
    expect(region).toBeTruthy();

    const status = renderer.root.findByProps({ role: "status" });
    expect(status.props["aria-live"]).toBe("polite");
    expect(status.props["aria-atomic"]).toBe("true");
    expect(status.children.join(" ")).toContain("You are offline");

    const button = renderer.root.findByType("button");
    expect(button.props.type).toBe("button");
    expect(button.children).toEqual(["Retry"]);
  });

  it("appears on an offline event and dismisses on an online event", () => {
    const renderer = mount();
    expect(renderer.toJSON()).toBeNull();

    emit("offline");
    expect(renderer.toJSON()).not.toBeNull();

    emit("online");
    expect(renderer.toJSON()).toBeNull();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tunaxa:resource-changed" }),
    );
  });

  it("dispatches a resource refresh when Retry is clicked after reconnection", () => {
    vi.stubGlobal("navigator", { onLine: false });
    const renderer = mount();

    vi.stubGlobal("navigator", { onLine: true });
    const button = renderer.root.findByType("button");
    act(() => {
      button.props.onClick();
    });

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tunaxa:resource-changed" }),
    );
    expect(renderer.toJSON()).toBeNull();
  });

  it("shows feedback without throwing when Retry is clicked while still offline", () => {
    vi.stubGlobal("navigator", { onLine: false });
    const renderer = mount();
    const button = renderer.root.findByType("button");

    expect(() => {
      act(() => {
        button.props.onClick();
      });
    }).not.toThrow();

    expect(dispatchEvent).not.toHaveBeenCalled();
    const status = renderer.root.findByProps({ role: "status" });
    expect(status.children.join(" ")).toContain("Still offline");
  });
});
