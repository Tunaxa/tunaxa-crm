import React from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelinePage } from "./PipelinePage";

const harness = vi.hoisted(() => ({
  role: "admin" as string | undefined,
  deals: [] as any[],
  toast: vi.fn(),
  listeners: new Map<string, Set<(event: any) => void>>(),
}));

vi.mock("../../lib/useResource", () => ({
  useResource: () => ({
    items: harness.deals,
    loading: false,
    error: "",
    load: vi.fn(async () => {}),
    create: vi.fn(async (payload: any) => ({ id: "deal-new", ...payload })),
    update: vi.fn(async (id: string, payload: any) => {
      harness.deals = harness.deals.map((deal) =>
        deal.id === id ? { ...deal, ...payload } : deal,
      );
      return { id, ...payload };
    }),
    remove: vi.fn(async () => ({})),
  }),
}));

vi.mock("./pipelines/usePipelineDefinitions", () => ({
  usePipelineDefinitions: () => ({
    definitions: [
      {
        id: "p1",
        name: "Pipeline A",
        entityType: "deal",
        isDefault: true,
        stages: [
          { key: "new", label: "New", probability: 10, order: 0 },
          { key: "won", label: "Won", probability: 100, order: 1 },
        ],
      },
    ],
    loading: false,
    error: "",
    unavailable: false,
    saving: false,
    load: vi.fn(),
    save: vi.fn(),
    setDefault: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock("../../context/AppContext", () => ({
  useApp: () => ({
    user: harness.role
      ? { id: "u1", name: "User", email: "user@example.test", role: harness.role }
      : null,
    toast: harness.toast,
  }),
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));

vi.mock("../../components/records/useSchema", () => ({
  useSchema: () => ({ fields: [], loading: false, error: "" }),
}));

vi.mock("../../components/ui", () => ({
  PageHeader: ({ title, children }: any) => (
    <header>
      <h1>{title}</h1>
      {children}
    </header>
  ),
  money: (value: any) => `$${Number(value) || 0}`,
  Badge: ({ children }: any) => <span>{children}</span>,
  Empty: ({ title }: any) => <div>{title}</div>,
  Drawer: () => null,
  RevenueTicker: ({ total, count }: any) => (
    <div aria-label="Live won revenue">{`ticker:${total}:${count}`}</div>
  ),
}));

vi.mock("../../components/Icon", () => ({ Icon: () => null }));

vi.mock("../../components/imports/CsvImportWizard", () => ({
  CsvImportButton: () => <button type="button">Import CSV</button>,
}));

vi.mock("../../components/records/RecordForm", () => ({
  RecordForm: () => <aside>record form</aside>,
}));

vi.mock("./pipelines/pipelines.css", () => ({}));
vi.mock("./winFlashTicker.css", () => ({}));

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join(" ");
}

function byAriaLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAll((node) => node.props["aria-label"] === label)[0];
  if (!found) throw new Error(`Element not found: ${label}`);
  return found;
}

function emit(name: string, detail?: unknown): void {
  const event = { detail };
  for (const listener of harness.listeners.get(name) ?? []) listener(event);
}

const renderers: ReactTestRenderer[] = [];

function renderPage(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PipelinePage />);
  });
  renderers.push(renderer);
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.listeners.clear();
  harness.role = "admin";
  harness.deals = [
    {
      id: "d1",
      title: "Deal A",
      stage: "new",
      pipelineId: "p1",
      value: 2500,
    },
  ];
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  });
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: true }),
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
});

describe("win flash and live revenue ticker integration", () => {
  it("celebrates a local move into won once and flashes the won column", async () => {
    const renderer = renderPage();
    const select = byAriaLabel(renderer.root, "Move Deal A to stage");
    await act(async () => {
      select.props.onChange({ target: { value: "won" } });
    });
    expect(harness.toast).toHaveBeenCalledTimes(1);
    expect(harness.toast).toHaveBeenCalledWith("🎉 Deal won: $2500");
    expect(textOf(renderer.root)).toContain("🎉 Deal won: $2500");
    expect(textOf(renderer.root)).toContain("ticker:2500:1");
    const flashing = renderer.root.findAll(
      (node) =>
        typeof node.props.className === "string" &&
        node.props.className.includes("animate-win-flash"),
    );
    expect(flashing).toHaveLength(1);
    act(() => emit("tunaxa:resource-changed", { resource: "deals" }));
    expect(harness.toast).toHaveBeenCalledTimes(1);
  });

  it("celebrates a workspace-scoped remote win through the resource event", () => {
    const renderer = renderPage();
    harness.deals = harness.deals.map((deal) => ({ ...deal, stage: "won" }));
    act(() => {
      renderer.update(<PipelinePage />);
      emit("tunaxa:resource-changed");
    });
    expect(harness.toast).toHaveBeenCalledTimes(1);
    expect(harness.toast).toHaveBeenCalledWith("🎉 Deal won: $2500");
    expect(textOf(renderer.root)).toContain("ticker:2500:1");
    act(() => emit("tunaxa:resource-changed", { resource: "deals" }));
    expect(harness.toast).toHaveBeenCalledTimes(1);
  });

  it("escapes script text and ignores polluted or non-finite amounts", () => {
    harness.deals = [
      {
        id: "d2",
        title: "<script>alert(1)</script>",
        stage: "won",
        pipelineId: "p1",
        value: Number.NaN,
      },
    ];
    const renderer = renderPage();
    expect(textOf(renderer.root)).toContain("<script>alert(1)</script>");
    expect(textOf(renderer.root)).toContain("ticker:0:0");
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it("hides financial celebration from read-only viewers", () => {
    harness.role = "viewer";
    const renderer = renderPage();
    expect(
      renderer.root.findAll(
        (node) => node.props["aria-label"] === "Live won revenue",
      ),
    ).toHaveLength(0);
    act(() => emit("tunaxa:resource-changed"));
    expect(harness.toast).not.toHaveBeenCalled();
  });
});
