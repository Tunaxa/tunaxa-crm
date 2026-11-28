import { describe, expect, it } from "vitest";
import { parseContactEmailAnalytics } from "./contactEmailAnalyticsModel";

const payload = {
  data: {
    contactId: "cnt_acme",
    sentEmails: 3,
    openedEmails: 2,
    totalOpens: 5,
    clickCount: 1,
    openRate: 66.7,
    lastOpenedAt: "2026-01-03T10:00:00.000Z",
  },
};

describe("contact email analytics parsing", () => {
  it("parses the canonical { data } contract", () => {
    expect(parseContactEmailAnalytics(payload)).toEqual(payload.data);
  });

  it("rejects malformed envelopes", () => {
    expect(() => parseContactEmailAnalytics(null)).toThrow();
    expect(() => parseContactEmailAnalytics([])).toThrow();
    expect(() => parseContactEmailAnalytics({})).toThrow();
    expect(() => parseContactEmailAnalytics({ data: null })).toThrow();
    expect(() => parseContactEmailAnalytics({ data: [] })).toThrow();
    expect(() => parseContactEmailAnalytics({ data: { sentEmails: 1 } })).toThrow();
  });

  it("clamps non-finite, negative, and oversized values with a safe denominator", () => {
    const parsed = parseContactEmailAnalytics({
      data: {
        contactId: "cnt_bad",
        sentEmails: Number.NaN,
        openedEmails: -4,
        totalOpens: Number.POSITIVE_INFINITY,
        clickCount: -1,
        openRate: Number.NEGATIVE_INFINITY,
        lastOpenedAt: "not-a-date",
      },
    });
    expect(parsed).toEqual({
      contactId: "cnt_bad",
      sentEmails: 0,
      openedEmails: 0,
      totalOpens: 0,
      clickCount: 0,
      openRate: 0,
      lastOpenedAt: "",
    });
  });

  it("caps opened emails at sent emails and clamps the reported rate", () => {
    const parsed = parseContactEmailAnalytics({
      data: {
        contactId: "cnt_rate",
        sentEmails: 2,
        openedEmails: 99,
        totalOpens: 200,
        clickCount: 1,
        openRate: 900,
        lastOpenedAt: "2026-01-03T10:00:00.000Z",
      },
    });
    expect(parsed.openedEmails).toBe(2);
    expect(parsed.openRate).toBe(100);
  });

  it("blocks prototype-pollution keys without losing canonical fields", () => {
    const hostile = JSON.parse(
      '{"data":{"__proto__":{"sentEmails":999},"constructor":{"openRate":999},"prototype":{"clickCount":999},"contactId":"cnt_safe","sentEmails":1,"openedEmails":1,"totalOpens":2,"clickCount":0,"openRate":100,"lastOpenedAt":""}}',
    ) as unknown;
    const parsed = parseContactEmailAnalytics(hostile);
    expect(parsed).toEqual({
      contactId: "cnt_safe",
      sentEmails: 1,
      openedEmails: 1,
      totalOpens: 2,
      clickCount: 0,
      openRate: 100,
      lastOpenedAt: "",
    });
    expect(({} as Record<string, unknown>).sentEmails).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("preserves script text as data for React to escape", () => {
    const parsed = parseContactEmailAnalytics({
      data: {
        ...payload.data,
        contactId: "<script>alert(1)</script>",
      },
    });
    expect(parsed.contactId).toBe("<script>alert(1)</script>");
  });
});
