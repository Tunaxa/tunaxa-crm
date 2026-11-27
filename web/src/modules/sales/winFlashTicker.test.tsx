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
  reduced: true,
  listeners: new Map<string, Set<(event: any) => void>>(),
  columns: new Map<string, { scrollIntoView: ReturnType<typeof vi.fn> }>(),
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

function bannerOf(root: ReactTestInstance): ReactTestInstance {
  const found = root.findAll(
    (node) => node.props.className === "win-flash-center-banner",
  )[0];
  if (!found) throw new Error("Centered win flash banner not found");
  return found;
}

function emit(name: string, detail?: unknown): void {
  const event = { detail };
  for (const listener of harness.listeners.get(name) ?? []) listener(event);
}

function createNodeMock(element: any): any {
  const label = element.props?.["aria-label"];
  if (typeof label === "string" && label.endsWith(" deals")) {
    const key = label.slice(0, -6);
    let mock = harness.columns.get(key);
    if (!mock) {
      mock = { scrollIntoView: vi.fn() };
      harness.columns.set(key, mock);
    }
    return mock;
  }
  return {};
}

function cardNode(root: ReactTestInstance, title: string): ReactTestInstance {
  const found = root.findAll(
    (node) =>
      node.type === "article" &&
      typeof node.props.className === "string" &&
      node.props.className.includes("deal-card") &&
      textOf(node).includes(title),
  )[0];
  if (!found) throw new Error(`Deal card not found: ${title}`);
  return found;
}

function dragData() {
  const data = new Map<string, string>();
  return {
    setData: (key: string, value: string) => data.set(key, String(value)),
    getData: (key: string) => data.get(key) || "",
    dropEffect: "none",
    effectAllowed: "none",
  };
}

const renderers: ReactTestRenderer[] = [];

function renderPage(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PipelinePage />, { createNodeMock });
  });
  renderers.push(renderer);
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.listeners.clear();
  harness.columns.clear();
  harness.reduced = true;
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
    matchMedia: () => ({ matches: harness.reduced }),
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("win flash and live revenue ticker integration", () => {
  it("centers the won column and renders the centered banner on a select move", async () => {
    const renderer = renderPage();
    await act(async () => {
      byAriaLabel(renderer.root, "Move Deal A to stage").props.onChange({
        target: { value: "won" },
      });
    });
    const banner = bannerOf(renderer.root);
    expect(banner.props.role).toBe("status");
    expect(banner.props["aria-live"]).toBe("polite");
    expect(textOf(banner)).toContain("Deal A");
    expect(textOf(banner)).toContain("New → Won");
    expect(textOf(banner)).toContain("$2500");
    expect(harness.toast).toHaveBeenCalledTimes(1);
    expect(harness.toast).toHaveBeenCalledWith("🎉 Deal won: $2500");
    expect(textOf(renderer.root)).toContain("ticker:2500:1");
    expect(
      renderer.root.findAll(
        (node) =>
          typeof node.props.className === "string" &&
          node.props.className.includes("animate-win-flash"),
      ),
    ).toHaveLength(1);
    expect(harness.columns.get("Won")?.scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      inline: "center",
      block: "nearest",
    });
    act(() => emit("tunaxa:resource-changed", { resource: "deals" }));
    expect(harness.toast).toHaveBeenCalledTimes(1);
    expect(harness.columns.get("Won")?.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("centers the won column and renders the centered banner on a drag-and-drop move", async () => {
    const renderer = renderPage();
    const data = dragData();
    act(() => {
      cardNode(renderer.root, "Deal A").props.onDragStart({
        preventDefault() {},
        dataTransfer: data,
      });
    });
    await act(async () => {
      byAriaLabel(renderer.root, "Won deals").props.onDrop({
        preventDefault() {},
        dataTransfer: data,
      });
    });
    expect(textOf(bannerOf(renderer.root))).toContain("New → Won");
    expect(harness.columns.get("Won")?.scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      inline: "center",
      block: "nearest",
    });
    expect(harness.toast).toHaveBeenCalledTimes(1);
  });

  it("centers the won column for a workspace-scoped remote win", () => {
    const renderer = renderPage();
    harness.deals = harness.deals.map((deal) => ({ ...deal, stage: "won" }));
    act(() => {
      renderer.update(<PipelinePage />);
      emit("tunaxa:resource-changed");
    });
    expect(textOf(bannerOf(renderer.root))).toContain("New → Won");
    expect(harness.columns.get("Won")?.scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      inline: "center",
      block: "nearest",
    });
    expect(harness.toast).toHaveBeenCalledTimes(1);
    expect(textOf(renderer.root)).toContain("ticker:2500:1");
    act(() => emit("tunaxa:resource-changed", { resource: "deals" }));
    expect(harness.toast).toHaveBeenCalledTimes(1);
  });

  it("uses smooth scrolling when motion reduction is not preferred", async () => {
    harness.reduced = false;
    const renderer = renderPage();
    await act(async () => {
      byAriaLabel(renderer.root, "Move Deal A to stage").props.onChange({
        target: { value: "won" },
      });
    });
    expect(harness.columns.get("Won")?.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  });

  it("renders script titles as literal text and formats finite values", async () => {
    harness.deals = [
      {
        id: "d2",
        title: "<script>alert(1)</script>",
        stage: "new",
        pipelineId: "p1",
        value: 1200,
      },
    ];
    const renderer = renderPage();
    await act(async () => {
      byAriaLabel(renderer.root, "Move <script>alert(1)</script> to stage").props.onChange({
        target: { value: "won" },
      });
    });
    const banner = bannerOf(renderer.root);
    expect(textOf(banner)).toContain("<script>alert(1)</script>");
    expect(textOf(banner)).toContain("$1200");
    expect(renderer.root.findAll((node) => node.type === "script")).toHaveLength(0);
    expect(textOf(renderer.root)).toContain("ticker:1200:1");
  });

  it("clears banner and flash timers on re-trigger and unmount", async () => {
    vi.useFakeTimers();
    harness.deals = [
      ...harness.deals,
      { id: "d2", title: "Deal B", stage: "new", pipelineId: "p1", value: 3000 },
    ];
    const renderer = renderPage();
    await act(async () => {
      byAriaLabel(renderer.root, "Move Deal A to stage").props.onChange({
        target: { value: "won" },
      });
    });
    expect(vi.getTimerCount()).toBe(2);
    await act(async () => {
      byAriaLabel(renderer.root, "Move Deal B to stage").props.onChange({
        target: { value: "won" },
      });
    });
    expect(vi.getTimerCount()).toBe(2);
    renderers.splice(renderers.indexOf(renderer), 1);
    act(() => renderer.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hides the centered banner and ticker from read-only viewers", () => {
    harness.role = "viewer";
    const renderer = renderPage();
    expect(
      renderer.root.findAll(
        (node) => node.props["aria-label"] === "Live won revenue",
      ),
    ).toHaveLength(0);
    expect(
      renderer.root.findAll(
        (node) => node.props.className === "win-flash-center-banner",
      ),
    ).toHaveLength(0);
    act(() => emit("tunaxa:resource-changed"));
    expect(harness.toast).not.toHaveBeenCalled();
  });
});
