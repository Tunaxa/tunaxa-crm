import { describe, expect, it } from "vitest";
import {
  notificationDate,
  notificationError,
  notificationTarget,
  parseNotification,
  parseNotificationPage,
} from "./notificationModel";

const row = {
  id: "n_1",
  title: "Mention",
  message: "Hello",
  type: "mention",
  read: false,
  createdAt: "2026-10-10T10:00:00Z",
  link: "/contacts/c_1",
};

describe("notification response contract", () => {
  it("reads the scoped notification list envelope", () => {
    expect(
      parseNotificationPage({
        notifications: [row],
        unreadCount: 52,
        total: 71,
      }),
    ).toEqual({ notifications: [row], unreadCount: 52, total: 71 });
  });

  it("accepts an empty confirmed feed", () => {
    expect(
      parseNotificationPage({ notifications: [], unreadCount: 0, total: 0 }).total,
    ).toBe(0);
  });

  it.each([
    null,
    [],
    { notifications: [], total: 0 },
    { notifications: [], total: -1, unreadCount: 0 },
    { notifications: [row], total: 0, unreadCount: 0 },
    { notifications: [row, row], total: 2, unreadCount: 2 },
    { notifications: [{ ...row, read: "false" }], total: 1, unreadCount: 1 },
    { notifications: [row], total: 1, unreadCount: 2 },
  ])("rejects malformed or duplicate notification data", (value) => {
    expect(() => parseNotificationPage(value)).toThrow();
  });

  it("rejects prototype-pollution keys from parsed payloads", () => {
    const payload = JSON.parse(
      '{"id":"n_2","title":"Safe","read":false,"__proto__":{"polluted":true},"constructor":"bad"}',
    );
    expect(() => parseNotification(payload)).toThrow("Invalid notification");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("maps service errors without exposing raw text", () => {
    expect(notificationError({ status: 404 })).toContain("not available");
    expect(notificationError({ status: 401 })).toContain("Sign in");
    expect(notificationError({ status: 403 })).toContain("access");
    expect(notificationError(new Error("secret"))).not.toContain("secret");
  });

  it("handles missing dates", () => {
    expect(notificationDate("bad")).toBe("Date unavailable");
  });
});

describe("internal notification navigation", () => {
  it.each([
    "/contacts/contact_1",
    "/leads/lead-1",
    "/companies/company_1",
    "/deals/deal_1",
  ])("permits an established record route: %s", (link) => {
    expect(notificationTarget(link)).toBe(link);
  });

  it.each([
    "https://evil.example",
    "//evil.example",
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "/contacts/%2fother",
    "/contacts/a?redirect=x",
    "/contacts/../settings",
    "/ticket/t_1",
    "/tickets/t_1",
    "/contacts\\evil",
    null,
  ])("rejects unsafe or unsupported navigation: %s", (link) => {
    expect(notificationTarget(link)).toBeNull();
  });
});
