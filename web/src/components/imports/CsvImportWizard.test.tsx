import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CsvImportButton, CsvImportWizard } from "./CsvImportWizard";
import type { FieldSpec } from "../records/types";

const harness = vi.hoisted(() => ({
  role: "admin" as string | undefined,
  toast: vi.fn(),
  api: vi.fn(async (_path: string, _options?: { method?: string; body?: string }) => ({})),
  stepFocus: vi.fn(),
  link: { click: vi.fn(), remove: vi.fn() },
}));

vi.mock("../../context/AppContext", () => ({
  useApp: () => ({
    user: harness.role
      ? { id: "user-1", name: "Test User", email: "user@example.test", role: harness.role }
      : null,
    toast: harness.toast,
  }),
}));

vi.mock("../../lib/api", () => ({
  api: harness.api,
  json: (method: string, body?: unknown) => ({
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  }),
}));

vi.mock("../Icon", () => ({ Icon: () => null }));

vi.mock("../ui", () => ({
  Drawer: (props: { children: unknown; footer?: unknown }) => [props.children, props.footer],
}));

vi.mock("../records/useSchema", () => ({
  useSchema: () => ({
    fields: [],
    hiddenFields: [],
    maskedFields: [],
    loading: false,
    error: "",
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(globalThis as { window?: unknown }).window = {
  document: {
    createElement: vi.fn(() => harness.link),
    body: { appendChild: vi.fn() },
  },
  setTimeout: vi.fn((callback: () => void) => {
    callback();
    return 1;
  }),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
};

const fields: FieldSpec[] = [
  { key: "name", label: "Contact name", required: true },
  { key: "email", label: "Email", type: "email" },
];

function csvFile(name: string, text: string): File {
  const bytes = new TextEncoder().encode(text);
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer } as unknown as File;
}

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : child
          ? textOf(child)
          : "",
    )
    .join("");
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.findAll(
    (node) => node.type === "button" && textOf(node).includes(label),
  )[0];
}

function alerts(root: ReactTestInstance): string[] {
  return root.findAll((node) => node.props.role === "alert").map(textOf);
}

function renderWizard(context: {
  contextLabel?: string;
  preparePayload?: (payload: Record<string, unknown>) => Record<string, unknown>;
  unavailable?: boolean;
} = {}): ReactTestRenderer {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <CsvImportWizard
        resource="contacts"
        label="Contacts"
        fields={fields}
        onComplete={() => {}}
        onClose={() => {}}
        contextLabel={context.contextLabel}
        preparePayload={context.preparePayload}
        unavailable={context.unavailable}
      />,
      {
        createNodeMock: (element) =>
          element.props["data-csv-step"] === undefined
            ? {}
            : { focus: harness.stepFocus },
      },
    );
  });
  return renderer!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  harness.role = "admin";
});

describe("CSV import permissions", () => {
  it.each(["owner", "admin", "member"])("enables the import trigger for %s", (role) => {
    harness.role = role;
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <CsvImportButton resource="contacts" label="Contacts" fields={fields} onComplete={() => {}} />,
      );
    });
    const button = findButton(renderer!.root, "Import CSV");
    expect(button.props.disabled).toBe(false);
    expect(button.props.title).toBeUndefined();
    act(() => renderer!.unmount());
  });

  it.each(["viewer", undefined])("disables the import trigger for %s", (role) => {
    harness.role = role;
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <CsvImportButton resource="contacts" label="Contacts" fields={fields} onComplete={() => {}} />,
      );
    });
    const button = findButton(renderer!.root, "Import CSV");
    expect(button.props.disabled).toBe(true);
    expect(button.props.title).toContain("Import requires");
    act(() => renderer!.unmount());
  });

  it("blocks file upload and announces restricted access in the wizard", () => {
    harness.role = "viewer";
    const renderer = renderWizard();
    const input = renderer.root.findAll((node) => node.props.type === "file")[0];
    expect(input.props.disabled).toBe(true);
    expect(alerts(renderer.root).join(" ")).toContain(
      "Import requires member, admin or owner access.",
    );
    act(() => renderer.unmount());
  });
});

describe("CSV import accessibility", () => {
  it("announces upload errors with role=alert", async () => {
    const renderer = renderWizard();
    const input = renderer.root.findAll((node) => node.props.type === "file")[0];
    await act(async () => {
      input.props.onChange({
        target: { files: [csvFile("notes.txt", "name\nAlex")], value: "" },
      });
    });
    expect(alerts(renderer.root).join(" ")).toContain("Choose a .csv file");
    act(() => renderer.unmount());
  });

  it("announces mapping problems with role=alert", async () => {
    const renderer = renderWizard();
    const input = renderer.root.findAll((node) => node.props.type === "file")[0];
    await act(async () => {
      input.props.onChange({
        target: { files: [csvFile("contacts.csv", "name,email\nAlex,alex@example.test")], value: "" },
      });
    });
    const mapping = renderer.root.findAll(
      (node) => node.type === "select" && node.props.value === "name",
    )[0];
    await act(async () => {
      mapping.props.onChange({ target: { value: "" } });
    });
    expect(alerts(renderer.root).join(" ")).toContain("Map the required property: Contact name");
    act(() => renderer.unmount());
  });

  it("moves focus to the active step container on each transition", async () => {
    const renderer = renderWizard();
    expect(harness.stepFocus).toHaveBeenCalledTimes(1);
    harness.stepFocus.mockClear();

    const input = renderer.root.findAll((node) => node.props.type === "file")[0];
    await act(async () => {
      input.props.onChange({
        target: { files: [csvFile("contacts.csv", "name,email\nAlex,alex@example.test")], value: "" },
      });
    });
    expect(renderer.root.findAll((node) => node.props["data-csv-step"] === 1)).toHaveLength(1);
    expect(harness.stepFocus).toHaveBeenCalledTimes(1);

    await act(async () => {
      findButton(renderer.root, "Preview rows").props.onClick();
    });
    expect(renderer.root.findAll((node) => node.props["data-csv-step"] === 2)).toHaveLength(1);
    expect(harness.stepFocus).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it("revokes the object URL after downloading a template", () => {
    const createObjectURL = vi.fn(() => "blob:csv");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const renderer = renderWizard();
    act(() => {
      findButton(renderer.root, "Download template").props.onClick();
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:csv");
    expect(harness.link.click).toHaveBeenCalledTimes(1);
    expect(harness.link.remove).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});

describe("CSV import pipeline context", () => {
  it("announces the selected import destination", () => {
    const renderer = renderWizard({ contextLabel: "Pipeline B" });
    expect(textOf(renderer.root)).toContain("Import destination: Pipeline B");
    act(() => renderer.unmount());
  });

  it("announces an unavailable destination and blocks the file input", () => {
    const renderer = renderWizard({ unavailable: true });
    expect(alerts(renderer.root).join(" ")).toContain("import destination is unavailable");
    expect(renderer.root.findAll((node) => node.props.type === "file")[0].props.disabled).toBe(true);
    act(() => renderer.unmount());
  });

  it("applies preparePayload to each saved row", async () => {
    const transform = vi.fn((payload: Record<string, unknown>) => ({
      ...payload,
      pipelineId: "pipeline-b",
      probability: 75,
    }));
    const renderer = renderWizard({ preparePayload: transform });
    const input = renderer.root.findAll((node) => node.props.type === "file")[0];
    await act(async () => {
      input.props.onChange({
        target: {
          files: [csvFile("contacts.csv", "name,email\nAlex,alex@example.test")],
          value: "",
        },
      });
    });
    await act(async () => {
      findButton(renderer.root, "Preview rows").props.onClick();
    });
    await act(async () => {
      findButton(renderer.root, "Import 1 valid rows").props.onClick();
    });
    expect(transform).toHaveBeenCalledTimes(1);
    const post = harness.api.mock.calls.find(
      ([path, options]) => path === "/contacts" && options?.method === "POST",
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post![1]?.body))).toEqual({
      name: "Alex",
      email: "alex@example.test",
      pipelineId: "pipeline-b",
      probability: 75,
    });
    act(() => renderer.unmount());
  });
});
