import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilterGroup } from "../components/FilterBuilder";
import { useResource } from "./useResource";

type Row = { id: string; name: string };

type Options = {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  q?: string;
  filters?: FilterGroup | null;
  all?: boolean;
};

const mocks = vi.hoisted(() => ({
  api: vi.fn<(path: string) => Promise<unknown>>(),
  toast: vi.fn<(message: string, tone?: string) => void>(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: mocks.api };
});

vi.mock("../context/AppContext", () => ({
  useApp: () => ({ toast: mocks.toast }),
}));

type HookValue = ReturnType<typeof useResource<Row>>;

const mounted: ReactTestRenderer[] = [];
let latest: HookValue;

function Probe({ resource, options }: { resource: string; options: Options }) {
  latest = useResource<Row>(resource, options);
  return null;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const originalWindow = (globalThis as { window?: unknown }).window;

function mount(options: Options = {}): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(Probe, { resource: "contacts", options }));
  });
  mounted.push(renderer);
  return renderer;
}

function rerender(renderer: ReactTestRenderer, options: Options): void {
  act(() => {
    renderer.update(createElement(Probe, { resource: "contacts", options }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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

function paramsOf(call: number): URLSearchParams {
  const path = mocks.api.mock.calls[call][0];
  return new URLSearchParams(path.slice(path.indexOf("?") + 1));
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.toast.mockReset();
  (globalThis as { window?: unknown }).window = new EventTarget();
});

afterEach(() => {
  while (mounted.length) {
    const renderer = mounted.pop();
    if (!renderer) break;
    act(() => renderer.unmount());
  }
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("useResource server-side pagination", () => {
  it("sends page, limit, trimmed q and serialized filters to the server", async () => {
    mocks.api.mockResolvedValue({
      data: [{ id: "1", name: "Acme" }],
      total: 1,
      page: 2,
      limit: 10,
    });
    const filters: FilterGroup = {
      $and: [{ field: "status", operator: "eq", value: "Active" }],
    };

    mount({ page: 2, limit: 10, q: "  acme  ", filters });
    await settle();

    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api.mock.calls[0][0].startsWith("/contacts?")).toBe(true);
    const params = paramsOf(0);
    expect(params.get("page")).toBe("2");
    expect(params.get("limit")).toBe("10");
    expect(params.get("q")).toBe("acme");
    expect(params.get("filters")).toBe(JSON.stringify(filters));
    expect(params.get("sortBy")).toBe("createdAt");
    expect(params.get("sortDir")).toBe("desc");
  });

  it("computes totalPages and hasMore from the paginated response", async () => {
    mocks.api.mockResolvedValue({ data: [], total: 95, page: 2, limit: 25 });
    const renderer = mount({ page: 2, limit: 25 });
    await settle();

    expect(latest.total).toBe(95);
    expect(latest.page).toBe(2);
    expect(latest.limit).toBe(25);
    expect(latest.totalPages).toBe(4);
    expect(latest.hasMore).toBe(true);

    rerender(renderer, { page: 4, limit: 25 });
    await settle();

    expect(latest.totalPages).toBe(4);
    expect(latest.hasMore).toBe(false);
  });

  it("omits page/limit in all mode and exposes a single logical page", async () => {
    mocks.api.mockResolvedValue([
      { id: "1", name: "A" },
      { id: "2", name: "B" },
    ]);

    mount({ all: true });
    await settle();

    const params = paramsOf(0);
    expect(params.has("page")).toBe(false);
    expect(params.has("limit")).toBe(false);
    expect(latest.items).toHaveLength(2);
    expect(latest.total).toBe(2);
    expect(latest.totalPages).toBe(1);
    expect(latest.hasMore).toBe(false);
  });

  it("ignores a stale response when the query changes mid-flight", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mocks.api
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const renderer = mount({ q: "old" });
    await settle();
    expect(latest.loading).toBe(true);

    rerender(renderer, { q: "new" });
    await settle();
    expect(mocks.api).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve({
        data: [{ id: "stale", name: "Stale" }],
        total: 1,
        page: 1,
        limit: 25,
      });
      await Promise.resolve();
    });
    expect(latest.items).toEqual([]);

    await act(async () => {
      second.resolve({
        data: [{ id: "fresh", name: "Fresh" }],
        total: 1,
        page: 1,
        limit: 25,
      });
      await Promise.resolve();
    });
    expect(latest.items).toEqual([{ id: "fresh", name: "Fresh" }]);
    expect(latest.loading).toBe(false);
  });

  it("propagates request errors into the error state and a toast", async () => {
    mocks.api.mockRejectedValueOnce(new Error("network down"));

    mount();
    await settle();

    expect(latest.error).toBe("network down");
    expect(latest.loading).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith("network down", "error");
  });

  it("falls back to a valid page and limit for invalid numeric options", async () => {
    mocks.api.mockResolvedValue({ data: [], total: 0, page: 1, limit: 25 });

    mount({ page: 0, limit: -3 });
    await settle();

    expect(latest.page).toBe(1);
    expect(latest.limit).toBe(25);
    expect(paramsOf(0).get("page")).toBe("1");
    expect(paramsOf(0).get("limit")).toBe("25");
  });
});
