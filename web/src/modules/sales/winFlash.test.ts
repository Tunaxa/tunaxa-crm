import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  dealAmount,
  isWonTransition,
  prefersReducedMotion,
  resourceFromEvent,
  safeDealRecord,
  stageLabel,
  transitionLabel,
  wonRevenue,
  wonStageKey,
} from "./winFlash";

describe("win flash safety helpers", () => {
  it("builds null-prototype records and drops dangerous field keys", () => {
    const payload = JSON.parse(
      '{"id":"d1","stage":"won","value":1200,"__proto__":{"polluted":true},"constructor":"x","prototype":"y","a.b":1}',
    );
    const record = safeDealRecord(payload);
    expect(Object.getPrototypeOf(record)).toBeNull();
    expect(record.id).toBe("d1");
    expect(record.stage).toBe("won");
    expect(Object.keys(record)).toEqual(["id", "stage", "value"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects non-finite and negative amounts", () => {
    expect(dealAmount(1200)).toBe(1200);
    expect(dealAmount("1200")).toBe(1200);
    expect(dealAmount(Number.NaN)).toBeNull();
    expect(dealAmount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(dealAmount(-1)).toBeNull();
    expect(dealAmount("not a number")).toBeNull();
  });

  it("recognises canonical and custom won stages only", () => {
    expect(wonStageKey("won")).toBe("won");
    expect(wonStageKey(" Closed Won ")).toBe("Closed Won");
    expect(wonStageKey("custom-win", [{ key: "custom-win", probability: 100 }])).toBe("custom-win");
    expect(wonStageKey("new")).toBeNull();
    expect(isWonTransition("new", "won")).toBe(true);
    expect(isWonTransition("won", "won")).toBe(false);
  });

  it("totals only valid won records", () => {
    const rows = [
      { id: "a", stage: "won", value: 1000 },
      { id: "b", stage: "won", value: Number.NaN },
      { id: "c", stage: "won", value: Number.POSITIVE_INFINITY },
      { id: "d", stage: "won", value: -50 },
      { id: "e", stage: "new", value: 5000 },
      JSON.parse('{"id":"f","stage":"won","value":250,"__proto__":{"x":1}}'),
    ];
    expect(wonRevenue(rows)).toEqual({ total: 1250, count: 2 });
  });

  it("sanitises resource names from window events", () => {
    const event = { detail: { resource: "deals" } } as unknown as Event;
    expect(resourceFromEvent(event)).toBe("deals");
    const polluted = {
      detail: JSON.parse('{"resource":"deals","constructor":"deals"}'),
    } as unknown as Event;
    expect(resourceFromEvent(polluted)).toBe("deals");
    expect(resourceFromEvent({ detail: {} } as unknown as Event)).toBeNull();
  });

  it("reads reduced-motion preference safely", () => {
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({ matches: query.includes("reduce") }),
    });
    expect(prefersReducedMotion()).toBe(true);
    vi.stubGlobal("window", {});
    expect(prefersReducedMotion()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("builds stage transition labels with escaped stage text", () => {
    const stages = [
      { key: "negotiation", label: "<b>Negotiation</b>" },
      { key: "won", label: "Won" },
    ];
    expect(stageLabel("negotiation", stages)).toBe("<b>Negotiation</b>");
    expect(transitionLabel("negotiation", "won", stages)).toBe(
      "<b>Negotiation</b> → Won",
    );
    expect(transitionLabel(undefined, "won", stages)).toBe("Moved to Won");
  });
});

describe("win flash ticker styles", () => {
  const css = readFileSync(new URL("./winFlashTicker.css", import.meta.url), "utf8");

  it("uses canonical tokens and no hardcoded hex colors", () => {
    for (const token of [
      "--surface",
      "--border",
      "--text",
      "--muted",
      "--primary",
      "--green",
      "--shadow-lg",
    ]) {
      expect(css).toContain(`var(${token})`);
    }
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("covers reduced motion and 375px-safe layout", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".animate-win-flash");
    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  });

  it("centers the win banner with viewport-safe width", () => {
    for (const rule of [
      ".win-flash-center-banner",
      "top: 50%",
      "left: 50%",
      "transform: translate(-50%, -50%)",
      "z-index: 60",
      "pointer-events: none",
      "max-width: min(420px, calc(100vw - 32px))",
    ]) {
      expect(css).toContain(rule);
    }
    const reduced = css.split("@media (prefers-reduced-motion: reduce)")[1];
    expect(reduced).toContain(".win-flash-center-banner");
    expect(reduced).toContain("animation: none !important");
  });
});
