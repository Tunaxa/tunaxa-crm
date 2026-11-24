import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ColumnPicker } from "./ColumnPicker";
import {
  columnCacheKey,
  filterRestrictedColumns,
  useColumnPreferences,
  type ColumnOption,
} from "./columnPreferences";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  getToken: vi.fn(() => ""),
  json: vi.fn((method: string, body?: unknown) => ({
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })),
}));

vi.mock("../lib/api", () => ({
  api: mocks.api,
  getToken: mocks.getToken,
  json: mocks.json,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const docListeners: Record<string, Array<(event: unknown) => void>> = {};

function makeHarness() {
  const focus = {
    trigger: vi.fn(),
    first: vi.fn(),
    last: vi.fn(),
  };
  const first = { focus: focus.first };
  const last = { focus: focus.last };
  const panel = {
    focus: vi.fn(),
    querySelector: () => first,
    querySelectorAll: () => [first, last],
    contains: () => false,
  };
  const trigger = {
    focus: focus.trigger,
    getBoundingClientRect: () => ({
      top: 100,
      bottom: 120,
      left: 100,
      right: 160,
    }),
  };
  const root = { contains: () => false };
  const createNodeMock = (element: React.ReactElement<Record<string, unknown>>) => {
    const props = element.props;
    if (props["aria-haspopup"] === "dialog") return trigger;
    if (props.role === "dialog") return panel;
    if (props.className === "column-picker") return root;
    return {};
  };
  return { focus, first, last, panel, createNodeMock };
}

const columns: ColumnOption[] = [
  { key: "name", label: "Name", required: true },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
];

beforeEach(() => {
  for (const key of Object.keys(docListeners)) delete docListeners[key];
  (globalThis as { document?: unknown }).document = {
    body: undefined,
    activeElement: null,
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      docListeners[type] = [...(docListeners[type] || []), handler];
    },
    removeEventListener: (type: string, handler: (event: unknown) => void) => {
      docListeners[type] = (docListeners[type] || []).filter(
        (item) => item !== handler,
      );
    },
  };
  (globalThis as { window?: unknown }).window = {
    innerWidth: 1200,
    innerHeight: 900,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const values = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  mocks.api.mockReset();
  mocks.getToken.mockReset();
  mocks.getToken.mockReturnValue("");
  mocks.json.mockClear();
});

describe("ColumnPicker dialog semantics and focus management", () => {
  it("exposes dialog trigger ARIA and opens a labelled modal dialog", () => {
    const harness = makeHarness();
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(
        <ColumnPicker
          columns={columns}
          visibleKeys={["name", "email"]}
          onChange={() => {}}
        />,
        { createNodeMock: harness.createNodeMock },
      );
    });
    if (!renderer) throw new Error("ColumnPicker did not render");
    const mounted = renderer;
    const trigger = () => mounted.root.findByProps({ "aria-haspopup": "dialog" });

    expect(trigger().props["aria-haspopup"]).toBe("dialog");
    expect(trigger().props["aria-expanded"]).toBe(false);
    expect(trigger().props["aria-controls"]).toBeTruthy();
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);

    act(() => trigger().props.onClick());

    const dialog = mounted.root.findByProps({ role: "dialog" });
    expect(dialog.props["aria-modal"]).toBe("true");
    expect(dialog.props["aria-labelledby"]).toBeTruthy();
    expect(trigger().props["aria-expanded"]).toBe(true);
    expect(harness.focus.first).toHaveBeenCalled();
    act(() => mounted.unmount());
  });

  it("traps Tab and Shift+Tab inside the dialog and restores focus on Escape", () => {
    const harness = makeHarness();
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(
        <ColumnPicker
          columns={columns}
          visibleKeys={["name"]}
          onChange={() => {}}
        />,
        { createNodeMock: harness.createNodeMock },
      );
    });
    if (!renderer) throw new Error("ColumnPicker did not render");
    const mounted = renderer;
    act(() => mounted.root.findByProps({ "aria-haspopup": "dialog" }).props.onClick());

    const dialog = () => mounted.root.findByProps({ role: "dialog" });
    const middlePrevent = vi.fn();
    (globalThis.document as { activeElement: unknown }).activeElement = {
      focus: vi.fn(),
    };
    act(() =>
      dialog().props.onKeyDown({
        key: "Tab",
        shiftKey: false,
        preventDefault: middlePrevent,
      }),
    );
    expect(middlePrevent).not.toHaveBeenCalled();

    (globalThis.document as { activeElement: unknown }).activeElement =
      harness.last;
    const forwardPrevent = vi.fn();
    act(() =>
      dialog().props.onKeyDown({
        key: "Tab",
        shiftKey: false,
        preventDefault: forwardPrevent,
      }),
    );
    expect(forwardPrevent).toHaveBeenCalled();
    expect(harness.focus.first).toHaveBeenCalled();

    (globalThis.document as { activeElement: unknown }).activeElement =
      harness.first;
    const backwardPrevent = vi.fn();
    act(() =>
      dialog().props.onKeyDown({
        key: "Tab",
        shiftKey: true,
        preventDefault: backwardPrevent,
      }),
    );
    expect(backwardPrevent).toHaveBeenCalled();
    expect(harness.focus.last).toHaveBeenCalled();

    act(() =>
      dialog().props.onKeyDown({
        key: "Escape",
        preventDefault: vi.fn(),
      }),
    );
    expect(harness.focus.trigger).toHaveBeenCalled();
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    act(() => mounted.unmount());
  });

  it("closes on Done and Reset, writes the reset selection, and restores focus", () => {
    const harness = makeHarness();
    const onChange = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(
        <ColumnPicker
          columns={columns}
          visibleKeys={["name", "email"]}
          onChange={onChange}
        />,
        { createNodeMock: harness.createNodeMock },
      );
    });
    if (!renderer) throw new Error("ColumnPicker did not render");
    const mounted = renderer;
    act(() => mounted.root.findByProps({ "aria-haspopup": "dialog" }).props.onClick());

    const action = (label: string) =>
      mounted.root
        .findAllByType("button")
        .find((button) => button.props.children === label);
    const reset = action("Reset");
    const done = action("Done");
    if (!reset || !done) throw new Error("dialog actions not rendered");
    act(() => reset.props.onClick());
    expect(onChange).toHaveBeenCalledWith([]);
    expect(harness.focus.trigger).toHaveBeenCalled();
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);

    act(() => mounted.root.findByProps({ "aria-haspopup": "dialog" }).props.onClick());
    const doneAgain = action("Done");
    if (!doneAgain) throw new Error("Done action not rendered");
    act(() => doneAgain.props.onClick());
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    act(() => mounted.unmount());
  });

  it("closes on an outside pointer-down and restores focus", () => {
    const harness = makeHarness();
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(
        <ColumnPicker
          columns={columns}
          visibleKeys={["name"]}
          onChange={() => {}}
        />,
        { createNodeMock: harness.createNodeMock },
      );
    });
    if (!renderer) throw new Error("ColumnPicker did not render");
    const mounted = renderer;
    act(() => mounted.root.findByProps({ "aria-haspopup": "dialog" }).props.onClick());
    expect(docListeners.pointerdown).toHaveLength(1);
    act(() => docListeners.pointerdown[0]({ target: {} }));
    expect(harness.focus.trigger).toHaveBeenCalled();
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    act(() => mounted.unmount());
  });

  it("omits masked fields from the rendered picker options", () => {
    const harness = makeHarness();
    const visible = filterRestrictedColumns(
      [...columns, { key: "salary", label: "Salary" }],
      { maskedFields: ["salary"] },
    );
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(
        <ColumnPicker
          columns={visible}
          visibleKeys={["name"]}
          onChange={() => {}}
        />,
        { createNodeMock: harness.createNodeMock },
      );
    });
    if (!renderer) throw new Error("ColumnPicker did not render");
    const mounted = renderer;
    act(() => mounted.root.findByProps({ "aria-haspopup": "dialog" }).props.onClick());
    const labels = mounted.root
      .findAllByType("span")
      .map((node) => String(node.props.children ?? ""));
    expect(labels.some((label) => label.includes("Salary"))).toBe(false);
    expect(mounted.root.findAllByType("small")).toHaveLength(1);
    expect(mounted.root.findAllByType("input")).toHaveLength(3);
    act(() => mounted.unmount());
  });
});

function HookHarness({
  onReady,
}: {
  onReady: (value: ReturnType<typeof useColumnPreferences>) => void;
}) {
  const value = useColumnPreferences("contacts", columns, "u1", "w1");
  onReady(value);
  return null;
}

async function mountHook() {
  let value: ReturnType<typeof useColumnPreferences> | undefined;
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<HookHarness onReady={(next) => { value = next; }} />);
  });
  if (!renderer || !value) throw new Error("hook did not render");
  return {
    renderer,
    current: () => value as ReturnType<typeof useColumnPreferences>,
  };
}

describe("useColumnPreferences persistence contract", () => {
  it("hydrates visible keys from GET /api/user/preferences", async () => {
    mocks.getToken.mockReturnValue("token");
    mocks.api.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/user/preferences"
          ? {
              preferences: {
                columnVisibility: {
                  contacts: ["email", "__proto__", "unknown"],
                },
              },
            }
          : {},
      ),
    );
    const mounted = await mountHook();
    expect(mocks.api).toHaveBeenCalledWith("/user/preferences");
    expect(mounted.current().visibleKeys).toEqual(["name", "email"]);
    act(() => mounted.renderer.unmount());
  });

  it("sends a sanitized PATCH payload on toggle", async () => {
    mocks.getToken.mockReturnValue("token");
    mocks.api.mockResolvedValue({});
    const mounted = await mountHook();
    act(() => mounted.current().change(["email", "__proto__", "unknown"]));
    const call = mocks.api.mock.calls.find((args) => args[1]);
    expect(call?.[0]).toBe("/user/preferences");
    expect(call?.[1].method).toBe("PATCH");
    expect(JSON.parse(call?.[1].body)).toEqual({
      columnVisibility: { contacts: ["name", "email"] },
    });
    expect(mounted.current().visibleKeys).toEqual(["name", "email"]);
    act(() => mounted.renderer.unmount());
  });

  it("rolls back optimistically changed keys when the API fails", async () => {
    mocks.getToken.mockReturnValue("token");
    mocks.api.mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method === "PATCH") return Promise.reject(new Error("500"));
      return Promise.resolve({
        preferences: { columnVisibility: { contacts: ["email"] } },
      });
    });
    const mounted = await mountHook();
    expect(mounted.current().visibleKeys).toEqual(["name", "email"]);
    await act(async () => {
      mounted.current().change(["phone"]);
      await Promise.resolve();
    });
    expect(mounted.current().visibleKeys).toEqual(["name", "email"]);
    expect(mounted.current().saveError).toContain("Previous choices were restored");
    act(() => mounted.renderer.unmount());
  });

  it("uses the user-and-workspace-scoped cache while unauthenticated", async () => {
    const mounted = await mountHook();
    expect(mocks.api).not.toHaveBeenCalled();
    act(() => mounted.current().change(["email", "__proto__"]));
    const key = columnCacheKey("w1", "u1", "contacts");
    expect(key).toBe("tunaxa:columns:v2:w1:u1:contacts");
    expect(JSON.parse(localStorage.getItem(key) || "[]")).toEqual([
      "name",
      "email",
    ]);
    expect(mocks.api).not.toHaveBeenCalled();
    act(() => mounted.renderer.unmount());
  });
});
