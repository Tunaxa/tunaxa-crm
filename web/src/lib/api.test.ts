import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, registerLogoutHandler, setToken } from "./api";

const storage = new Map<string, string>();

const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, String(value)),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
};

describe("API authentication interceptor", () => {
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", localStorageMock);
    vi.stubGlobal("fetch", vi.fn());
    setToken("old-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    storage.clear();
  });

  it("refreshes the token and retries the request once", async () => {
    const fetchMock = vi.mocked(fetch);

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "new-token" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );

    const logout = vi.fn();
    const unregister = registerLogoutHandler(logout);

    try {
      const result = await api<{ success: boolean }>("/contacts");

      expect(result).toEqual({ success: true });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(localStorageMock.getItem("tunaxa.token")).toBe("new-token");
      expect(logout).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("logs out when token refresh fails", async () => {
    const fetchMock = vi.mocked(fetch);

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Refresh failed" }), { status: 401 }),
      );

    const logout = vi.fn();
    const unregister = registerLogoutHandler(logout);

    try {
      await expect(api("/contacts")).rejects.toMatchObject({ status: 401 });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(logout).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });



  
  it("logs out when the retried request still returns 401", async () => {
    const fetchMock = vi.mocked(fetch);

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "new-token" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      );

    const logout = vi.fn();
    const unregister = registerLogoutHandler(logout);

    try {
      await expect(api("/contacts")).rejects.toMatchObject({ status: 401 });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(logout).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

});
