import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RevenueTicker } from "./RevenueTicker";

vi.mock("../../components/ui", () => ({
  money: (value: number) => `$${value}`,
}));

vi.mock("./PixelIndicator", () => ({
  PixelIndicator: ({ colorClass }: { colorClass: string }) => (
    <span className={colorClass} />
  ),
}));

vi.mock("../../modules/sales/winFlashTicker.css", () => ({}));

const harness = vi.hoisted(() => ({
  reduced: true,
  frames: [] as FrameRequestCallback[],
  cancelFrame: vi.fn(),
  clearTimer: vi.fn(),
  setTimer: vi.fn(() => 99 as unknown as ReturnType<typeof setTimeout>),
}));

function textOf(node: any): string {
  return node.children
    .map((child: any) => (typeof child === "string" ? child : textOf(child)))
    .join(" ");
}

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  harness.reduced = true;
  harness.frames = [];
  harness.cancelFrame = vi.fn();
  harness.clearTimer = vi.fn();
  harness.setTimer = vi.fn(() => 99 as unknown as ReturnType<typeof setTimeout>);
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: harness.reduced }),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    harness.frames.push(callback);
    return harness.frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => harness.cancelFrame(id));
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    ((callback: () => void) => {
      void callback;
      return harness.setTimer();
    }) as typeof setTimeout,
  );
  vi.spyOn(globalThis, "clearTimeout").mockImplementation(
    ((id: unknown) => harness.clearTimer(id)) as typeof clearTimeout,
  );
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RevenueTicker", () => {
  it("renders real workspace totals with no simulated baseline", () => {
    act(() => {
      renderer = create(<RevenueTicker total={12345} count={2} />);
    });
    const root = renderer!.root;
    expect(textOf(root)).toContain("$12345");
    expect(textOf(root)).toContain("2 won deals");
    expect(textOf(root)).not.toContain("48500");
    expect(root.findAll((node) => node.props["aria-label"] === "Live won revenue")).toHaveLength(1);
  });

  it("skips numeric tweening when reduced motion is preferred", () => {
    act(() => {
      renderer = create(<RevenueTicker total={500} count={1} />);
    });
    act(() => {
      renderer!.update(<RevenueTicker total={900} count={2} />);
    });
    expect(harness.frames).toHaveLength(0);
    expect(textOf(renderer!.root)).toContain("$900");
  });

  it("cancels pending animation frames on unmount", () => {
    harness.reduced = false;
    act(() => {
      renderer = create(<RevenueTicker total={100} count={1} />);
    });
    act(() => {
      renderer!.update(<RevenueTicker total={500} count={2} />);
    });
    expect(harness.frames.length).toBeGreaterThan(0);
    act(() => {
      renderer!.unmount();
      renderer = null;
    });
    expect(harness.cancelFrame).toHaveBeenCalled();
  });

  it("clears the pulse timer on unmount", () => {
    harness.reduced = false;
    act(() => {
      renderer = create(<RevenueTicker total={100} count={1} />);
    });
    act(() => {
      renderer!.update(<RevenueTicker total={500} count={2} />);
    });
    act(() => {
      harness.frames[0]?.(0);
      harness.frames[1]?.(500);
    });
    expect(harness.setTimer).toHaveBeenCalled();
    act(() => {
      renderer!.unmount();
      renderer = null;
    });
    expect(harness.clearTimer).toHaveBeenCalled();
  });
});
