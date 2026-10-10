import { describe, expect, it, vi } from "vitest";
import { readAllNotifications, readNotification } from "./notificationActions";
const row = { id: "n_1", title: "Mention", read: true };
describe("confirmed notification read actions", () => {
  it("marks the requested notification read using the backend contract", async () => {
    const request = vi.fn().mockResolvedValue(row); expect((await readNotification("n_1", request)).read).toBe(true);
    expect(request.mock.calls[0][0]).toBe("/notifications/n_1/read"); expect(request.mock.calls[0][1].method).toBe("PATCH");
  });
  it.each([{ ...row, id: "other" }, { ...row, read: false }, null])("rejects missing or mismatched acknowledgements", async value => {
    await expect(readNotification("n_1", async () => value)).rejects.toThrow();
  });
  it("accepts a confirmed all-read update count", async () => { expect(await readAllNotifications(async () => ({ updated: 7 }))).toBe(7); });
  it.each([null, {}, { updated: -1 }, { updated: "7" }])("rejects unconfirmed all-read updates", async value => { await expect(readAllNotifications(async () => value)).rejects.toThrow(); });
  it("preserves a network rejection rather than claiming a read update", async () => { await expect(readNotification("n_1", async () => { throw new Error("offline"); })).rejects.toThrow("offline"); });
});
