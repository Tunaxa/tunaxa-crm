import { readFileSync } from "node:fs";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContactEmailAnalytics,
  ContactEmailAnalyticsView,
} from "./ContactEmailAnalytics";
import { parseContactEmailAnalytics } from "./contactEmailAnalyticsModel";

const harness = vi.hoisted(() => ({
  api: vi.fn(),
  listeners: new Map<string, Set<(event: any) => void>>(),
}));

vi.mock("../../lib/api", () => ({ api: harness.api }));
vi.mock("./contactEmailAnalytics.css", () => ({}));
vi.mock("../../components/ui", () => ({
  Badge: ({ children, tone }: any) => (
    <span data-tone={tone}>{children}</span>
  ),
}));

const baseData = {
  contactId: "cnt_acme",
  sentEmails: 3,
  openedEmails: 2,
  totalOpens: 4,
  clickCount: 1,
  openRate: 66.7,
  lastOpenedAt: "2026-01-03T10:00:00.000Z",
};

const analytics = () => parseContactEmailAnalytics({ data: baseData });

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join(" ");
}

function emit(name: string, detail?: unknown): void {
  const event = { detail };
  for (const listener of harness.listeners.get(name) ?? []) listener(event);
}

function mediaBlock(source: string, breakpoint: string): string {
  const header = `@media (max-width: ${breakpoint}) {`;
  const start = source.indexOf(header);
  if (start < 0) return "";
  let depth = 0;
  for (let index = start + header.length - 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
}

const renderers: ReactTestRenderer[] = [];

async function renderAnalytics(contactId = "cnt_acme"): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ContactEmailAnalytics contactId={contactId} />);
  });
  renderers.push(renderer);
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.listeners.clear();
  harness.api.mockResolvedValue({ data: baseData });
  vi.stubGlobal("window", {
    addEventListener: (name: string, listener: (event: any) => void) => {
      const set = harness.listeners.get(name) ?? new Set();
      set.add(listener);
      harness.listeners.set(name, set);
    },
    removeEventListener: (name: string, listener: (event: any) => void) => {
      harness.listeners.get(name)?.delete(listener);
    },
  });
});

afterEach(() => {
  renderers.splice(0).forEach((renderer) => act(() => renderer.unmount()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("contact email analytics UI", () => {
  it("renders escaped text, accessible metrics, and a valid time element", () => {
    const html = renderToStaticMarkup(
      <ContactEmailAnalyticsView
        analytics={parseContactEmailAnalytics({
          data: { ...baseData, contactId: "<script>alert(1)</script>" },
        })}
        loading={false}
        error={false}
        onRetry={vi.fn()}
      />,
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain('aria-label="Open rate 66.7%"');
    expect(html).toContain("Sent emails");
    expect(html).toContain("<dd>3</dd>");
    expect(html).toContain("<dd>2</dd>");
    expect(html).toContain("<dd>4</dd>");
    expect(html).toContain("<dd>1</dd>");
    expect(html).toContain("<time");
    expect(html).toContain('dateTime="2026-01-03T10:00:00.000Z"');
  });

  it("uses role status for loading and empty states", () => {
    const loading = renderToStaticMarkup(
      <ContactEmailAnalyticsView
        analytics={null}
        loading={true}
        error={false}
        onRetry={vi.fn()}
      />,
    );
    const empty = renderToStaticMarkup(
      <ContactEmailAnalyticsView
        analytics={parseContactEmailAnalytics({
          data: { ...baseData, sentEmails: 0, openedEmails: 0, totalOpens: 0, clickCount: 0, openRate: 0, lastOpenedAt: "" },
        })}
        loading={false}
        error={false}
        onRetry={vi.fn()}
      />,
    );
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Loading email analytics");
    expect(empty).toContain('role="status"');
    expect(empty).toContain("No sent emails tracked");
  });

  it("uses an abortable scoped request and refreshes on scoped resource events", async () => {
    const updated = parseContactEmailAnalytics({
      data: { ...baseData, sentEmails: 7, openedEmails: 5, totalOpens: 9, openRate: 71.4 },
    });
    harness.api.mockResolvedValueOnce({ data: baseData }).mockResolvedValueOnce({ data: updated });
    const renderer = await renderAnalytics();
    expect(harness.api).toHaveBeenCalledTimes(1);
    expect(harness.api).toHaveBeenCalledWith(
      "/contacts/cnt_acme/email-analytics",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(textOf(renderer.root)).toContain("66.7");

    await act(async () => {
      emit("tunaxa:resource-changed", { resource: "messages" });
    });
    expect(harness.api).toHaveBeenCalledTimes(2);
    expect(textOf(renderer.root)).toContain("71.4");

    await act(async () => {
      emit("tunaxa:resource-changed", { resource: "deals" });
    });
    expect(harness.api).toHaveBeenCalledTimes(2);
  });

  it("surfaces errors with role alert and retries on demand", async () => {
    harness.api
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ data: baseData });
    const renderer = await renderAnalytics();
    const alert = renderer.root.findAll((node) => node.props.role === "alert")[0];
    expect(textOf(alert)).toContain("Could not load email analytics");
    const button = renderer.root.findAll(
      (node) => node.type === "button" && textOf(node) === "Retry",
    )[0];
    expect(button).toBeTruthy();
    await act(async () => {
      button.props.onClick();
    });
    expect(harness.api).toHaveBeenCalledTimes(2);
    expect(textOf(renderer.root)).toContain("66.7");
  });

  it("styles with canonical tokens, reduced motion, and 375px-safe rules", () => {
    const css = readFileSync(
      new URL("./contactEmailAnalytics.css", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const mobile = mediaBlock(css, "768px");
    for (const token of [
      "--surface",
      "--border",
      "--text",
      "--muted",
      "--primary",
      "--green",
      "--amber",
      "--red",
      "--focus-ring",
    ]) {
      expect(css).toContain(`var(${token})`);
    }
    expect(css).toContain("html.dark");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
    expect(mobile).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(mobile).toContain("min-width: 0");
    expect(mobile).toContain("overflow-wrap: anywhere");
  });

  it("keeps the parsed view free of script nodes", () => {
    const renderer = create(
      <ContactEmailAnalyticsView
        analytics={analytics()}
        loading={false}
        error={false}
        onRetry={vi.fn()}
      />,
    );
    expect(renderer.root.findAll((node) => node.type === "script")).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
