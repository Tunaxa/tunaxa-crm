import { describe, expect, it } from "vitest";
import { canManageRecords } from "../../components/records/rbac";
import {
  confirmedStatus,
  createdEndpoint,
  parseEndpoint,
  parseEndpoints,
  webhookError,
  webhookPayload,
} from "./webhookModel";

const endpoint = {
  id: "hook_1",
  url: "https://receiver.example/events",
  events: ["contact.created"],
  is_active: true,
  created_at: "2026-11-26T00:00:00.000Z",
};
const secret = `whsec_${"a".repeat(64)}`;

describe("outgoing webhook model", () => {
  it("normalizes event input without losing custom event names", () => {
    expect(
      webhookPayload(` ${endpoint.url} `, "contact.created, deal.won\ncontact.created"),
    ).toEqual({ url: endpoint.url, events: ["contact.created", "deal.won"] });
  });

  it.each([
    "invalid",
    "file:///tmp/x",
    "javascript:alert(1)",
    "https://user:password@example.com",
    "http://127.0.0.1",
    "http://localhost",
    "http://10.0.0.1",
    "http://169.254.169.254",
    "http://[::1]",
    "https://service.local",
    "https://receiver.example\u0000",
  ])("rejects unsafe destination input", (url) => {
    expect(() => webhookPayload(url, "contact.created")).toThrow();
  });

  it("requires at least one subscribed event", () => {
    expect(() => webhookPayload(endpoint.url, " , \n ")).toThrow();
  });

  it("reads paginated list envelopes without requiring total to equal page size", () => {
    expect(parseEndpoints({ data: [endpoint], total: 42, page: 1, limit: 10 })).toEqual([
      parseEndpoint(endpoint),
    ]);
  });

  it.each([
    null,
    [],
    { data: "not-an-array", total: 1 },
    { data: [endpoint], total: "1" },
    { data: [{ ...endpoint, is_active: "true" }], total: 1 },
    { data: [{ ...endpoint, events: [] }], total: 1 },
    { data: [endpoint, endpoint], total: 2 },
  ])("rejects malformed subscription data", (value) => {
    expect(() => parseEndpoints(value)).toThrow();
  });

  it("rejects prototype-pollution keys in objects and event lists", () => {
    const polluted = JSON.parse(
      `{"id":"w_1","url":"${endpoint.url}","events":["contact.created","__proto__"],"is_active":true,"__proto__":{"polluted":true},"constructor":"bad"}`,
    );
    expect(() => parseEndpoint(polluted)).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("exposes only the one-time secret from the creation response", () => {
    const result = createdEndpoint(
      { ...endpoint, secret, hasSecret: true },
      { url: endpoint.url, events: endpoint.events },
    );
    expect(result.secret).toBe(secret);
    expect(result.endpoint).not.toHaveProperty("secret");
    expect(result.endpoint.hasSecret).toBe(true);
    expect(parseEndpoint({ ...endpoint, secret })).not.toHaveProperty("secret");
  });

  it("distinguishes successful creation from a missing secret", () => {
    expect(
      createdEndpoint(endpoint, { url: endpoint.url, events: endpoint.events }).secret,
    ).toBeNull();
  });

  it("does not accept creation confirmation for a different URL", () => {
    expect(() =>
      createdEndpoint(
        { ...endpoint, url: "https://other.example" },
        { url: endpoint.url, events: endpoint.events },
      ),
    ).toThrow();
  });

  it("accepts confirmed activation changes", () => {
    expect(
      confirmedStatus({ ...endpoint, is_active: false }, parseEndpoint(endpoint)).is_active,
    ).toBe(false);
  });

  it.each([endpoint, { ...endpoint, id: "another", is_active: false }, null])(
    "rejects unconfirmed status changes",
    (value) => {
      expect(() => confirmedStatus(value, parseEndpoint(endpoint))).toThrow();
    },
  );

  it.each(["admin", "member", "Owner", "owner", " ADMIN "])(
    "matches backend write roles through canManageRecords",
    (role) => {
      expect(canManageRecords(role)).toBe(true);
    },
  );

  it("keeps viewers read-only", () => {
    expect(canManageRecords("viewer")).toBe(false);
    expect(canManageRecords(undefined)).toBe(false);
  });

  it("reports safe authorization messages", () => {
    expect(webhookError({ status: 403 }, "fallback")).toContain("permission");
    expect(webhookError(new Error("secret"), "fallback")).toBe("fallback");
  });
});
