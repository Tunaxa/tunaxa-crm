import { describe, expect, it } from "vitest";
import { notificationDate, notificationError, notificationTarget, parseNotificationPage } from "./notificationModel";
const row = { id: "n_1", title: "Mention", message: "Hello", type: "mention", read: false, createdAt: "2026-10-10T10:00:00Z", link: "/contacts/c_1" };
describe("notification API contract", () => {
  it("reads the merged backend's list/count envelope", () => {
    expect(parseNotificationPage({ notifications: [row], unreadCount: 52, total: 71 })).toEqual({ notifications: [row], unreadCount: 52, total: 71 });
  });
  it("accepts an empty confirmed feed", () => { expect(parseNotificationPage({ notifications: [], unreadCount: 0, total: 0 }).total).toBe(0); });
  it.each([null, [], { notifications: [], total: 0 }, { notifications: [], total: -1, unreadCount: 0 }, { notifications: [row], total: 0, unreadCount: 0 }, { notifications: [row, row], total: 2, unreadCount: 2 }, { notifications: [{ ...row, read: "false" }], total: 1, unreadCount: 1 }])("rejects malformed or duplicate notification data", value => {
    expect(() => parseNotificationPage(value)).toThrow();
  });
  it.each(["/contacts/contact_1", "/leads/lead-1", "/companies/company_1", "/deals/deal_1"])("permits an established record route: %s", link => { expect(notificationTarget(link)).toBe(link); });
  it.each(["https://evil.example", "//evil.example", "javascript:alert(1)", "/contacts/%2fother", "/contacts/a?redirect=x", "/contacts/../settings", "/ticket/t_1", "/tickets/t_1", "/contacts\\evil", null])("rejects unsafe or unsupported navigation", link => { expect(notificationTarget(link)).toBeNull(); });
  it("reports a missing service instead of claiming no notifications", () => { expect(notificationError({ status: 404 })).toContain("not available yet"); });
  it("reports authentication failures", () => { expect(notificationError({ status: 401 })).toContain("Sign in"); expect(notificationError({ status: 403 })).toContain("access"); });
  it("does not expose a raw server error", () => { expect(notificationError(new Error("secret"))).not.toContain("secret"); });
  it("handles missing dates", () => { expect(notificationDate("bad")).toBe("Date unavailable"); });
});
