
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

describe("api retry behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("retries a GET request after a temporary server error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Temporary error" }), {
          status: 500,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "1" }], total: 1 }), {
          status: 200,
        }),
      );

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });

    const result = await api<{ data: { id: string }[]; total: number }>(
      "/resources",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe("1");
  });

  it("does not automatically retry a POST request after a network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });

    await expect(
      api("/resources", {
        method: "POST",
        body: JSON.stringify({ name: "Example" }),
      }),
    ).rejects.toThrow("Network error");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
