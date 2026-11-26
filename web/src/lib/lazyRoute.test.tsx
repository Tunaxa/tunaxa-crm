import { createElement, Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { RouteErrorBoundary, RouteFallback, lazyRoute } from "./lazyRoute";

function Probe({ label }: { label: string }) {
  return createElement("span", null, label);
}

describe("lazyRoute", () => {
  it("resolves default and named module exports", async () => {
    const Named = lazyRoute(() => Promise.resolve({ Probe }), "Probe");
    const Default = lazyRoute(() => Promise.resolve({ default: Probe }));
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(
          Suspense,
          { fallback: createElement(RouteFallback) },
          createElement(Named, { label: "named" }),
          createElement(Default, { label: "default" }),
        ),
      );
    });

    const html = JSON.stringify(renderer?.toJSON());

    expect(html).toContain("named");
    expect(html).toContain("default");
    expect(html).not.toContain("missing export");
  });

  it("renders an accessible loading fallback without French strings", () => {
    const html = renderToStaticMarkup(createElement(RouteFallback));

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Loading…");
    expect(html).not.toContain("Chargement");
  });

  it("catches chunk rejection without leaking stacks and recovers on Retry", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error("SECRET_STACK_SIGNATURE"))
      .mockResolvedValueOnce({ Probe: () => createElement("span", null, "Recovered") });
    const Broken = lazyRoute(loader, "Probe");
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          createElement(
            RouteErrorBoundary,
            { onRetry: () => Broken.retry() },
            createElement(
              Suspense,
              { fallback: createElement(RouteFallback) },
              createElement(Broken, { label: "initial" }),
            ),
          ),
        );
      });

      let html = JSON.stringify(renderer?.toJSON());

      expect(html).toContain('"role":"alert"');
      expect(html).toContain("Retry");
      expect(html).not.toContain("SECRET_STACK_SIGNATURE");

      const retryButton = renderer?.root.findByType("button");

      await act(async () => {
        retryButton?.props.onClick();
      });

      html = JSON.stringify(renderer?.toJSON());

      expect(html).toContain("Recovered");
      expect(html).not.toContain('"role":"alert"');
      expect(html).not.toContain("SECRET_STACK_SIGNATURE");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
