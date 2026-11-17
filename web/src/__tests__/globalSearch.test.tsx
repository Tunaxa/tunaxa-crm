import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SearchResult = {
  id: string;
  type: string;
  route: string;
  name: string;
  detail?: string;
};

type SearchGroups = {
  leads: SearchResult[];
  contacts: SearchResult[];
  companies: SearchResult[];
  deals: SearchResult[];
  tasks: SearchResult[];
  recordings: SearchResult[];
};

const EMPTY_GROUPS: SearchGroups = {
  leads: [],
  contacts: [],
  companies: [],
  deals: [],
  tasks: [],
  recordings: [],
};

function groups(partial: Partial<SearchGroups>): SearchGroups {
  return { ...EMPTY_GROUPS, ...partial };
}

function result(
  id: string,
  name: string,
  route = `/leads/${id}`,
  type = "Lead",
): SearchResult {
  return { id, type, name, route, detail: `detail-${id}` };
}

const mocks = vi.hoisted(() => ({
  navigate: vi.fn<(to: string) => void>(),
  api: vi.fn<(path: string) => Promise<SearchGroups>>(),
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: mocks.api };
});

import { GlobalSearch } from "../App";

const originalWindow = (globalThis as { window?: unknown }).window;
const originalDocument = (globalThis as { document?: unknown }).document;
const mounted: ReactTestRenderer[] = [];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function createNodeMock() {
  return { focus: () => {} };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flattenText(value: unknown): string {
  if (value === null || value === undefined || typeof value === "boolean") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(flattenText).join("");
  }
  if (typeof value === "object" && "props" in value) {
    const element = value as { props: { children?: unknown } };
    return flattenText(element.props.children);
  }
  return "";
}

function isStatusNode(node: ReactTestInstance): boolean {
  const className = String(node.props.className ?? "");
  return className.split(/\s+/).includes("search-status");
}

type Ui = {
  input: () => ReactTestInstance;
  dialog: () => ReactTestInstance;
  listbox: () => ReactTestInstance;
  options: () => ReactTestInstance[];
  groups: () => ReactTestInstance[];
  labels: () => string[];
  status: () => ReactTestInstance | undefined;
};

function mount(onClose: () => void = () => {}): Ui {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(<GlobalSearch onClose={onClose} />, { createNodeMock });
  });
  if (!renderer) throw new Error("GlobalSearch did not render");
  const mountedRenderer = renderer;
  mounted.push(mountedRenderer);

  return {
    input: () => mountedRenderer.root.findByProps({ role: "combobox" }),
    dialog: () => mountedRenderer.root.findByProps({ role: "dialog" }),
    listbox: () => mountedRenderer.root.findByProps({ role: "listbox" }),
    options: () => mountedRenderer.root.findAllByProps({ role: "option" }),
    groups: () => mountedRenderer.root.findAllByProps({ role: "group" }),
    labels: () =>
      mountedRenderer.root
        .findAll(
          (node) =>
            typeof node.props.className === "string" &&
            node.props.className === "search-group-label",
        )
        .map((node) => flattenText(node.props.children)),
    status: () => mountedRenderer.root.findAll(isStatusNode)[0],
  };
}

function typeInto(ui: Ui, value: string): void {
  act(() => {
    ui.input().props.onChange({ target: { value } });
  });
}

function keyPress(ui: Ui, key: string): void {
  act(() => {
    ui.dialog().props.onKeyDown({
      key,
      target: { type: "text" },
      preventDefault: () => {},
    });
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // Node has no window; GlobalSearch uses window.setTimeout/clearTimeout.
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { document?: unknown }).document = { activeElement: null };
  mocks.api.mockReset();
  mocks.api.mockResolvedValue(EMPTY_GROUPS);
  mocks.navigate.mockReset();
});

afterEach(() => {
  while (mounted.length > 0) {
    const renderer = mounted.pop();
    if (!renderer) break;
    try {
      act(() => renderer.unmount());
    } catch {
      // Already unmounted by a test.
    }
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  (globalThis as { window?: unknown }).window = originalWindow;
  (globalThis as { document?: unknown }).document = originalDocument;
});

describe("GlobalSearch query handling", () => {
  it("debounces /api/search and renders grouped results with linked ARIA ids", async () => {
    mocks.api.mockResolvedValue(
      groups({
        leads: [result("1", "Acme Lead")],
        contacts: [result("2", "Acme Contact", "/contacts/2", "Contact")],
      }),
    );
    const ui = mount();

    typeInto(ui, "acme");
    expect(mocks.api).not.toHaveBeenCalled();

    await advance(179);
    expect(mocks.api).not.toHaveBeenCalled();

    await advance(1);
    await flush();
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api).toHaveBeenCalledWith("/search?q=acme");
    expect(ui.status()).toBeUndefined();

    const input = ui.input();
    expect(input.props.role).toBe("combobox");
    expect(input.props["aria-expanded"]).toBe(true);
    expect(typeof input.props["aria-controls"]).toBe("string");
    expect(ui.listbox().props.id).toBe(input.props["aria-controls"]);

    expect(ui.groups()).toHaveLength(2);
    expect(ui.labels()).toEqual(["Leads", "Contacts"]);

    const options = ui.options();
    expect(options).toHaveLength(2);
    const optionIds = options.map((option) => String(option.props.id));
    expect(new Set(optionIds).size).toBe(2);
    expect(input.props["aria-activedescendant"]).toBe(optionIds[0]);
    expect(flattenText(options[0].props.children)).toContain("Acme Lead");
    expect(flattenText(options[1].props.children)).toContain("Acme Contact");
  });

  it("ignores a stale response that resolves after a newer query", async () => {
    const first = deferred<SearchGroups>();
    const second = deferred<SearchGroups>();
    mocks.api
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const ui = mount();

    typeInto(ui, "a");
    await advance(180);
    expect(mocks.api).toHaveBeenCalledTimes(1);

    typeInto(ui, "ab");
    await advance(180);
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(mocks.api).toHaveBeenLastCalledWith("/search?q=ab");

    await act(async () => {
      second.resolve(groups({ leads: [result("new", "Beta Corp")] }));
    });
    await flush();
    expect(flattenText(ui.options()[0]?.props.children ?? "")).toContain(
      "Beta Corp",
    );

    await act(async () => {
      first.resolve(groups({ leads: [result("old", "Alpha Inc")] }));
    });
    await flush();
    expect(flattenText(ui.options()[0]?.props.children ?? "")).toContain(
      "Beta Corp",
    );
    expect(flattenText(ui.options()[0]?.props.children ?? "")).not.toContain(
      "Alpha Inc",
    );
  });

  it("renders an accessible loading status while a query is pending", async () => {
    const pending = deferred<SearchGroups>();
    mocks.api.mockReturnValue(pending.promise);
    const ui = mount();

    typeInto(ui, "load");
    const status = ui.status();
    expect(status).toBeDefined();
    expect(status?.props.role).toBe("status");
    expect(status?.props["aria-live"]).toBe("polite");
    expect(flattenText(status?.props.children)).toContain("Searching");
    expect(ui.input().props["aria-describedby"]).toBe(status?.props.id);

    await advance(180);
    await act(async () => {
      pending.resolve(EMPTY_GROUPS);
    });
    await flush();
    expect(ui.status()).toBeUndefined();
  });

  it("renders an accessible error status instead of an empty result set", async () => {
    mocks.api.mockRejectedValue(new Error("boom"));
    const ui = mount();

    typeInto(ui, "fail");
    await advance(180);
    await flush();

    const status = ui.status();
    expect(status?.props.role).toBe("alert");
    expect(status?.props["aria-live"]).toBe("assertive");
    expect(String(status?.props.className)).toContain("search-status-error");
    expect(flattenText(status?.props.children)).toContain(
      "Search failed: boom",
    );
    expect(ui.options()).toHaveLength(0);
  });
});

describe("GlobalSearch keyboard and focus behaviour", () => {
  it("wraps Arrow navigation and guards Enter and Escape", async () => {
    const onClose = vi.fn();
    mocks.api.mockResolvedValue(
      groups({
        leads: [result("1", "First"), result("2", "Second")],
        contacts: [result("3", "Third", "/contacts/3", "Contact")],
      }),
    );
    const ui = mount(onClose);

    typeInto(ui, "a");
    await advance(180);
    await flush();

    const optionIds = ui.options().map((option) => String(option.props.id));
    expect(optionIds).toHaveLength(3);
    expect(ui.input().props["aria-activedescendant"]).toBe(optionIds[0]);
    expect(ui.options()[0]?.props["aria-selected"]).toBe(true);

    keyPress(ui, "ArrowDown");
    expect(ui.input().props["aria-activedescendant"]).toBe(optionIds[1]);
    expect(ui.options()[1]?.props["aria-selected"]).toBe(true);

    keyPress(ui, "ArrowUp");
    keyPress(ui, "ArrowUp");
    expect(ui.input().props["aria-activedescendant"]).toBe(optionIds[2]);

    keyPress(ui, "ArrowDown");
    expect(ui.input().props["aria-activedescendant"]).toBe(optionIds[0]);

    keyPress(ui, "Enter");
    expect(mocks.navigate).toHaveBeenCalledWith("/leads/1");
    expect(onClose).toHaveBeenCalledTimes(1);

    keyPress(ui, "Escape");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("does not navigate when the selected result has no route", async () => {
    const onClose = vi.fn();
    mocks.api.mockResolvedValue(
      groups({ leads: [{ id: "1", type: "Lead", name: "No Route", route: "" }] }),
    );
    const ui = mount(onClose);

    typeInto(ui, "x");
    await advance(180);
    await flush();
    keyPress(ui, "Enter");

    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("restores focus to the previously focused element on unmount", () => {
    const focus = vi.fn();
    (globalThis as { document?: unknown }).document = {
      activeElement: { focus },
    };

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(<GlobalSearch onClose={() => {}} />, { createNodeMock });
    });
    if (!renderer) throw new Error("GlobalSearch did not render");
    const mountedRenderer = renderer;
    mounted.push(mountedRenderer);

    act(() => {
      mountedRenderer.unmount();
    });
    const index = mounted.indexOf(mountedRenderer);
    if (index >= 0) mounted.splice(index, 1);

    expect(focus).toHaveBeenCalledTimes(1);
  });
});
