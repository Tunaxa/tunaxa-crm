import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const viteConfig = read("../../vite.config.ts");
const appSource = read("../App.tsx");
const helperSource = read("../lib/lazyRoute.tsx");
const addedSources = [
  "../lib/lazyRoute.tsx",
  "../components/reports/RevenueForecastChart.tsx",
  "../pages/dashboard/DashboardPage.tsx",
].map((path) => ({ path, source: read(path) }));

describe("hardened lazy loading wiring", () => {
  it("keeps the shared dev proxy and adds deterministic chunk splitting", () => {
    expect(viteConfig).toContain('import { getHost, getPort } from "../backend/runtime.js"');
    expect(viteConfig).toContain("const apiTarget = `http://${getHost()}:${getPort()}`");
    expect(viteConfig).toContain('id.includes("@xyflow")');
    expect(viteConfig).toContain('return "react-flow"');
    expect(viteConfig).toContain('return "charts"');
    expect(viteConfig).toContain('return "react-vendor"');
    expect(viteConfig).not.toContain('"/api": "http://127.0.0.1:3001"');
  });

  it("reuses shared lazy helpers and preserves merged features", () => {
    expect(appSource).toContain("lazyRoute(");
    expect(appSource).toContain("<RouteBoundary");
    expect(appSource).toContain("<RouteErrorBoundary");
    expect(helperSource).toContain("<RouteFallback");
    expect(helperSource).toContain('role="status"');
    expect(helperSource).toContain('aria-live="polite"');
    expect(helperSource).toContain('role="alert"');
    expect(helperSource).not.toContain("Chargement");

    for (const marker of [
      "ColumnPicker",
      "ModuleGate",
      "OfflineBanner",
      "NotificationDrawer",
      "useNotifications",
      "EmailComposerDrawer",
      "InboxPage",
      "DesignSystemPage",
      "WorkflowDetailPage",
      'path="/tickets"',
      'path="/integrations"',
      'path="/design-system"',
      'path="/workflows/:id"',
      '"notification.created"',
      '"notification.updated"',
      '"pipeline.definition_created"',
      '"execution.processed"',
    ]) {
      expect(appSource).toContain(marker);
    }
  });

  it("uses canonical tokens and adds no unnecessary comments", () => {
    const dashboard = addedSources.find((item) => item.path.endsWith("DashboardPage.tsx"));
    const chart = addedSources.find((item) => item.path.endsWith("RevenueForecastChart.tsx"));

    expect(dashboard?.source).toContain('stroke="var(--primary)"');
    expect(chart?.source).toContain('fill="var(--primary)"');
    expect(chart?.source).toContain('stroke="var(--text)"');
    expect(chart?.source).not.toMatch(/#[0-9a-fA-F]{3,8}/);

    for (const { path, source } of addedSources) {
      expect(source, path).not.toContain("//");
      expect(source, path).not.toContain("/*");
      expect(source, path).not.toContain("*/");
    }
  });
});
