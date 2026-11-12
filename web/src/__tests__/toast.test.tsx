import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider, useApp } from "../context/AppContext";

type AppApi = ReturnType<typeof useApp>;

const TOAST_DURATION = 3200;

const originalWindow = (globalThis as { window?: unknown }).window;

function mountProvider() {
  let api: AppApi | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Capture() {
    api = useApp();
    return null;
  }

  act(() => {
    renderer = create(
      <AppProvider>
        <Capture />
      </AppProvider>,
    );
  });

  if (!renderer) throw new Error("AppProvider did not render");

  const mountedRenderer = renderer;

  return {
    getApi: () => {
      if (!api) throw new Error("AppProvider did not expose context");
      return api;
    },
    renderer: mountedRenderer,
  };
}

function isToastNode(node: ReactTestInstance): boolean {
  if (node.type !== "div") return false;
  const className = String(node.props.className ?? "");
  return className.split(/\s+/).includes("app-toast");
}

function toastNodes(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(isToastNode);
}

function toastText(node: ReactTestInstance): string {
  const [message] = node.findAllByType("span");
  return message.children.map(String).join("");
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  // AppContext uses window.setTimeout/window.clearTimeout; the Node test
  // environment has no window, so map it onto the (faked) globals.
  (globalThis as { window?: unknown }).window = globalThis;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("toast live region", () => {
  it("renders the polite live-region container up front", () => {
    const { renderer } = mountProvider();

    const stack = renderer.root.findByProps({ className: "toast-stack" });

    expect(stack.props["aria-live"]).toBe("polite");
    expect(stack.props["aria-atomic"]).toBe("false");
    expect(toastNodes(renderer)).toHaveLength(0);
  });
});

describe("toast rendering", () => {
  it("renders a successful toast as role=status with a dismiss control", () => {
    const { getApi, renderer } = mountProvider();

    act(() => {
      getApi().toast("Saved");
    });

    const [node] = toastNodes(renderer);
    expect(node).toBeDefined();
    expect(node.props.role).toBe("status");
    expect(String(node.props.className)).not.toContain("error");
    expect(toastText(node)).toBe("Saved");

    const dismiss = node.findByProps({ "aria-label": "Dismiss notification" });
    expect(dismiss.type).toBe("button");
    expect(dismiss.children.map(String).join("")).toBe("×");
  });

  it("renders an error toast as role=alert with the error modifier", () => {
    const { getApi, renderer } = mountProvider();

    act(() => {
      getApi().toast("Failed", "error");
    });

    const node = toastNodes(renderer).find(
      (candidate) => candidate.props.role === "alert",
    );

    expect(node).toBeDefined();
    expect(String(node?.props.className)).toContain("error");
    expect(toastText(node as ReactTestInstance)).toBe("Failed");
  });

  it("stacks multiple toasts in trigger order", () => {
    const { getApi, renderer } = mountProvider();

    act(() => {
      getApi().toast("First");
      getApi().toast("Second");
      getApi().toast("Failed", "error");
    });

    const nodes = toastNodes(renderer);
    expect(nodes.map(toastText)).toEqual(["First", "Second", "Failed"]);
    expect(nodes.map((node) => node.props.role)).toEqual([
      "status",
      "status",
      "alert",
    ]);
  });
});

describe("toast lifecycle", () => {
  it("auto-dismisses a toast after the configured duration", () => {
    const { getApi, renderer } = mountProvider();

    act(() => {
      getApi().toast("Saved");
    });
    expect(toastNodes(renderer)).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION);
    });
    expect(toastNodes(renderer)).toHaveLength(0);
  });

  it("clears the pending timer when dismissed manually", () => {
    const { getApi, renderer } = mountProvider();

    act(() => {
      getApi().toast("Saved");
    });
    const [node] = toastNodes(renderer);
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      node.findByProps({ "aria-label": "Dismiss notification" }).props.onClick();
    });

    expect(toastNodes(renderer)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears pending timers on unmount", () => {
    const { getApi, renderer } = mountProvider();

    act(() => {
      getApi().toast("Saved");
    });
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      renderer.unmount();
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});
