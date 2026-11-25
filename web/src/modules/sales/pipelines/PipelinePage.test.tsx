import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelinePage } from "../PipelinePage";

const harness = vi.hoisted(() => ({
  role: "admin" as string | undefined,
  definitions: [] as any[],
  deals: [] as any[],
  schemaFields: [] as any[],
  toast: vi.fn(),
  loadDeals: vi.fn(async () => {}),
  createDeal: vi.fn(async (payload: any) => ({ id: "deal-new", ...payload })),
  updateDeal: vi.fn(async (id: string, payload: any) => ({ id, ...payload })),
  removeDeal: vi.fn(async () => ({})),
  savePipeline: vi.fn(async (id: string | undefined, payload: any) => ({
    id: id || "pipeline-c",
    ...payload,
  })),
  setDefault: vi.fn(async () => ({})),
  removePipeline: vi.fn(async () => ({ ok: true, id: "pipeline-b" })),
  csvProps: null as any,
  recordProps: null as any,
}));

vi.mock("../../../lib/useResource", () => ({
  useResource: () => ({
    items: harness.deals,
    loading: false,
    error: "",
    load: harness.loadDeals,
    create: harness.createDeal,
    update: harness.updateDeal,
    remove: harness.removeDeal,
  }),
}));

vi.mock("./usePipelineDefinitions", () => ({
  usePipelineDefinitions: () => ({
    definitions: harness.definitions,
    loading: false,
    error: "",
    unavailable: false,
    saving: false,
    load: vi.fn(),
    save: harness.savePipeline,
    setDefault: harness.setDefault,
    remove: harness.removePipeline,
  }),
}));

vi.mock("../../../context/AppContext", () => ({
  useApp: () => ({
    user: harness.role
      ? {
          id: "user-1",
          name: "Test User",
          email: "user@example.test",
          role: harness.role,
        }
      : null,
    toast: harness.toast,
  }),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../../../components/records/useSchema", () => ({
  useSchema: () => ({
    fields: harness.schemaFields,
    loading: false,
    error: "",
  }),
}));

vi.mock("../../../components/ui", () => ({
  PageHeader: ({ title, children }: any) => (
    <header>
      <h1>{title}</h1>
      {children}
    </header>
  ),
  money: (value: any) => `$${Number(value) || 0}`,
  Badge: ({ children }: any) => <span>{children}</span>,
  Empty: ({ title }: any) => <div>{title}</div>,
  Drawer: ({ title, children, footer }: any) => (
    <aside aria-label={title}>
      <h2>{title}</h2>
      {children}
      {footer}
    </aside>
  ),
}));

vi.mock("../../../components/Icon", () => ({
  Icon: () => null,
}));

vi.mock("../../../components/imports/CsvImportWizard", () => ({
  CsvImportButton: (props: any) => {
    harness.csvProps = props;
    return <button type="button" disabled={props.disabled}>Import CSV</button>;
  },
}));

vi.mock("../../../components/records/RecordForm", () => ({
  RecordForm: (props: any) => {
    harness.recordProps = props;
    return <aside aria-label={props.title}>record form</aside>;
  },
}));

vi.mock("./pipelines.css", () => ({}));

const renderers: ReactTestRenderer[] = [];

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join(" ");
}

function buttons(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll(
    (node) => node.type === "button" && textOf(node).trim() === label,
  );
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = buttons(root, label)[0];
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

function byAriaLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAll((node) => node.props["aria-label"] === label)[0];
  if (!found) throw new Error(`Element not found: ${label}`);
  return found;
}

function alerts(root: ReactTestInstance): string[] {
  return root
    .findAll((node) => node.props.role === "alert")
    .map((node) => textOf(node));
}

function renderPage(): ReactTestRenderer {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(<PipelinePage />);
  });
  renderers.push(renderer!);
  return renderer!;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.role = "admin";
  harness.definitions = [
    {
      id: "pipeline-a",
      name: "Pipeline A",
      entityType: "deal",
      isDefault: false,
      stages: [
        { key: "new", label: "New", probability: 10, order: 0 },
        { key: "won", label: "Won", probability: 100, order: 1 },
      ],
    },
    {
      id: "pipeline-b",
      name: "Pipeline B",
      entityType: "deal",
      isDefault: true,
      stages: [{ key: "lead", label: "Lead", probability: 75, order: 0 }],
    },
  ];
  harness.deals = [
    {
      id: "deal-1",
      title: "Explicit A",
      stage: "new",
      pipelineId: "pipeline-a",
      value: 100,
    },
    { id: "deal-2", title: "Unbound B", stage: "lead", value: 200 },
  ];
  harness.schemaFields = [];
  harness.csvProps = null;
  harness.recordProps = null;
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  });
});

afterEach(() => {
  renderers.splice(0).forEach((renderer) => act(() => renderer.unmount()));
  vi.unstubAllGlobals();
});

describe("pipeline switcher and deal grouping", () => {
  it("groups unbound deals into the server default and allows switching", async () => {
    const renderer = renderPage();
    const select = byAriaLabel(renderer.root, "Pipeline");
    expect(select.props.value).toBe("pipeline-b");
    expect(textOf(renderer.root)).toContain("Unbound B");
    expect(textOf(renderer.root)).not.toContain("Explicit A");

    await act(async () => {
      select.props.onChange({ target: { value: "pipeline-a" } });
    });
    expect(textOf(renderer.root)).toContain("Explicit A");
    expect(textOf(renderer.root)).not.toContain("Unbound B");
  });

  it("binds the CSV import destination and payload transform", () => {
    renderPage();
    expect(harness.csvProps.contextLabel).toBe("Pipeline B");
    expect(harness.csvProps.unavailable).toBe(false);
    const payload = harness.csvProps.preparePayload({
      title: "Imported deal",
      stage: "lead",
    });
    expect(payload.pipelineId).toBe("pipeline-b");
    expect(payload.probability).toBe(75);
    expect(payload.stage).toBe("lead");
  });
});

describe("pipeline RBAC", () => {
  it("allows admin and owner to configure pipelines", () => {
    for (const role of ["admin", "Owner"]) {
      harness.role = role;
      const renderer = renderPage();
      expect(buttons(renderer.root, "Create pipeline")).toHaveLength(1);
      expect(buttons(renderer.root, "Edit pipeline")).toHaveLength(1);
      expect(buttons(renderer.root, "Add deal").length).toBeGreaterThan(0);
      expect(byAriaLabel(renderer.root, "Pipeline").props.disabled).toBe(false);
      act(() => renderer.unmount());
    }
  });

  it("keeps members deal-eligible but blocks pipeline configuration", () => {
    harness.role = "member";
    const renderer = renderPage();
    expect(buttons(renderer.root, "Create pipeline")).toHaveLength(0);
    expect(buttons(renderer.root, "Edit pipeline")).toHaveLength(0);
    expect(buttons(renderer.root, "Add deal").length).toBeGreaterThan(0);
    expect(byAriaLabel(renderer.root, "Pipeline").props.disabled).toBe(false);
  });

  it("keeps viewers read-only", () => {
    harness.role = "viewer";
    const renderer = renderPage();
    expect(buttons(renderer.root, "Create pipeline")).toHaveLength(0);
    expect(buttons(renderer.root, "Edit pipeline")).toHaveLength(0);
    expect(buttons(renderer.root, "Add deal")).toHaveLength(0);
    expect(byAriaLabel(renderer.root, "Pipeline").props.disabled).toBe(true);
    expect(textOf(renderer.root)).toContain("Read-only access");
  });
});

describe("pipeline builder", () => {
  it("reorders stages with keyboard-accessible buttons and saves the new order", async () => {
    const renderer = renderPage();
    await act(async () => {
      byAriaLabel(renderer.root, "Pipeline").props.onChange({
        target: { value: "pipeline-a" },
      });
    });
    await act(async () => {
      button(renderer.root, "Edit pipeline").props.onClick();
    });
    await act(async () => {
      byAriaLabel(renderer.root, "Move stage 2 up").props.onClick();
    });
    await act(async () => {
      button(renderer.root, "Save pipeline").props.onClick();
    });
    expect(harness.savePipeline).toHaveBeenCalledTimes(1);
    const saved = harness.savePipeline.mock.calls[0][1];
    expect(saved.stages.map((stage: any) => stage.key)).toEqual(["won", "new"]);
    expect(saved.stages.map((stage: any) => stage.order)).toEqual([0, 1]);
  });

  it("surfaces Set Default and Delete conflicts in role=alert banners", async () => {
    const renderer = renderPage();
    await act(async () => {
      button(renderer.root, "Edit pipeline").props.onClick();
    });

    const defaultConflict = Object.assign(
      new Error("Cannot set this pipeline as default right now"),
      { status: 409 },
    );
    harness.setDefault.mockRejectedValueOnce(defaultConflict);
    await act(async () => {
      button(renderer.root, "Set as default").props.onClick();
    });
    expect(alerts(renderer.root).join(" ")).toContain(
      "Cannot set this pipeline as default right now",
    );

    const deleteConflict = Object.assign(
      new Error("Cannot delete pipeline definition: 2 deal(s) still reference it"),
      { status: 409 },
    );
    harness.removePipeline.mockRejectedValueOnce(deleteConflict);
    await act(async () => {
      button(renderer.root, "Delete pipeline").props.onClick();
    });
    expect(alerts(renderer.root).join(" ")).toContain(
      "Cannot delete pipeline definition: 2 deal(s) still reference it",
    );
  });

  it("uses integer-only probability inputs with an explicit drawer label", async () => {
    const renderer = renderPage();
    await act(async () => {
      button(renderer.root, "Edit pipeline").props.onClick();
    });
    const probability = renderer.root.findAll(
      (node) => node.type === "input" && node.props.type === "number",
    )[0];
    expect(probability.props.step).toBe("1");
    expect(probability.props.min).toBe("0");
    expect(probability.props.max).toBe("100");
    expect(
      renderer.root.findAll(
        (node) =>
          node.type === "aside" && node.props["aria-label"] === "Edit pipeline",
      ),
    ).toHaveLength(1);
  });
});
