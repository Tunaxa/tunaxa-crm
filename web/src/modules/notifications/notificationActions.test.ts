import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readAllNotifications,
  readNotification,
  searchMentionableUsers,
} from "./notificationActions";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({
  api: apiMock,
  json: (method: string, body?: unknown) => ({
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  }),
}));

const row = {
  id: "n_1",
  title: "Mention",
  message: "Hello",
  type: "mention",
  read: true,
  createdAt: "2026-10-10T10:00:00Z",
  link: "/contacts/c_1",
};

beforeEach(() => {
  apiMock.mockReset();
});

describe("confirmed notification read actions", () => {
  it("marks the requested notification read using the backend contract", async () => {
    apiMock.mockResolvedValue(row);
    expect(await readNotification("n_1")).toEqual(row);
    expect(apiMock.mock.calls[0][0]).toBe("/notifications/n_1/read");
    expect(apiMock.mock.calls[0][1].method).toBe("PATCH");
  });

  it.each([{ ...row, id: "other" }, { ...row, read: false }, null])(
    "rejects missing or mismatched acknowledgements",
    async (value) => {
      apiMock.mockResolvedValue(value);
      await expect(readNotification("n_1")).rejects.toThrow();
    },
  );

  it("accepts a confirmed all-read update count", async () => {
    apiMock.mockResolvedValue({ updated: 7 });
    expect(await readAllNotifications()).toBe(7);
    expect(apiMock.mock.calls[0][0]).toBe("/notifications/read-all");
    expect(apiMock.mock.calls[0][1].method).toBe("POST");
  });

  it.each([null, {}, { updated: -1 }, { updated: "7" }])(
    "rejects unconfirmed all-read updates",
    async (value) => {
      apiMock.mockResolvedValue(value);
      await expect(readAllNotifications()).rejects.toThrow();
    },
  );

  it("preserves a network rejection rather than claiming a read update", async () => {
    apiMock.mockRejectedValue(new Error("offline"));
    await expect(readNotification("n_1")).rejects.toThrow("offline");
  });
});

describe("workspace-scoped mention lookup", () => {
  it("parses teammate suggestions from the scoped endpoint", async () => {
    apiMock.mockResolvedValue([{ id: "u_1", name: "Sarah", email: "sarah@example.com" }]);
    const users = await searchMentionableUsers("sara", new AbortController().signal);
    expect(users).toEqual([{ id: "u_1", name: "Sarah", email: "sarah@example.com" }]);
    expect(apiMock.mock.calls[0][0]).toBe("/notifications/mentionable?q=sara");
    expect(apiMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects malformed teammate rows", async () => {
    apiMock.mockResolvedValue([{ id: "u_1", name: "Sarah", email: "bad@example.com\nBcc:x@y.com" }]);
    await expect(
      searchMentionableUsers("sara", new AbortController().signal),
    ).rejects.toThrow();
  });
});
