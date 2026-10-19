import { describe, expect, it } from "vitest";
import { canManageWebhooks, confirmedStatus, createdEndpoint, parseEndpoint, parseEndpoints, webhookError, webhookPayload } from "./webhookModel";
const endpoint = { id: "hook_1", url: "https://receiver.example/events", events: ["contact.created"], is_active: true };
const secret = `whsec_${"a".repeat(64)}`;
describe("outgoing webhook contracts", () => {
  it("normalizes event input without losing custom event names", () => { expect(webhookPayload(` ${endpoint.url} `, "contact.created, deal.won\ncontact.created")).toEqual({ url: endpoint.url, events: ["contact.created", "deal.won"] }); });
  it.each(["invalid", "file:///tmp/x", "javascript:alert(1)", "https://user:password@example.com"])("rejects invalid destination input", url => { expect(() => webhookPayload(url, "contact.created")).toThrow(); });
  it("requires at least one subscribed event", () => { expect(() => webhookPayload(endpoint.url, " , \n ")).toThrow(); });
  it("reads the actual list envelope", () => { expect(parseEndpoints({ data: [endpoint], total: 1 })).toEqual([parseEndpoint(endpoint)]); });
  it.each([null, [], { data: [endpoint], total: 2 }, { data: [endpoint, endpoint], total: 2 }, { data: [{ ...endpoint, is_active: "true" }], total: 1 }, { data: [{ ...endpoint, events: [] }], total: 1 }])("rejects incomplete or malformed subscription data", value => { expect(() => parseEndpoints(value)).toThrow(); });
  it("only exposes the secret from the creation response", () => {
    const result = createdEndpoint({ ...endpoint, secret }, { url: endpoint.url, events: endpoint.events });
    expect(result.secret).toBe(secret); expect(result.endpoint).not.toHaveProperty("secret"); expect(parseEndpoint({ ...endpoint, secret })).not.toHaveProperty("secret");
  });
  it("keeps successful creation distinct from a missing secret", () => { expect(createdEndpoint(endpoint, { url: endpoint.url, events: endpoint.events }).secret).toBeNull(); });
  it("does not accept creation confirmation for a different URL", () => { expect(() => createdEndpoint({ ...endpoint, url: "https://other.example" }, { url: endpoint.url, events: endpoint.events })).toThrow(); });
  it("accepts confirmed activation changes", () => { expect(confirmedStatus({ ...endpoint, is_active: false }, parseEndpoint(endpoint)).is_active).toBe(false); });
  it.each([endpoint, { ...endpoint, id: "another", is_active: false }, null])("rejects unconfirmed status changes", value => { expect(() => confirmedStatus(value, parseEndpoint(endpoint))).toThrow(); });
  it.each(["admin", "member", "Owner", "owner"])("matches backend write roles", role => { expect(canManageWebhooks(role)).toBe(true); });
  it("does not offer writes to viewers", () => { expect(canManageWebhooks("viewer")).toBe(false); expect(canManageWebhooks()).toBe(false); });
  it("reports safe authorization messages", () => { expect(webhookError({ status: 403 }, "fallback")).toContain("permission"); expect(webhookError(new Error("secret"), "fallback")).toBe("fallback"); });
});
