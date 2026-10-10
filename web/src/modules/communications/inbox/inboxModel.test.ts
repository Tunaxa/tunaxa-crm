import { describe, expect, it } from "vitest";
import { assertEmailResponse, baseSubject, buildThreads, canSendEmail, deliveryLabel, emailPayload, fetchInbox, filterThreads, mailbox, parseMessage, replyRecipient, replySubject } from "./inboxModel";
const message = (value: Record<string, unknown> = {}) => parseMessage({ id: "one", channel: "Email", to: "customer@example.com", subject: "Proposal", body: "Hello", direction: "Outbound", status: "Sent", read: true, createdAt: "2026-10-10T10:00:00Z", ...value });

describe("complete inbox loading", () => {
  it("loads every page before grouping a conversation", async () => {
    const rows = Array.from({ length: 51 }, (_, index) => message({ id: `m${index}` })); const calls: string[] = [];
    const result = await fetchInbox(async path => { calls.push(path); const page = Number(new URLSearchParams(path.split("?")[1]).get("page")); return { items: rows.slice((page - 1) * 50, page * 50), total: 51, page, limit: 50, hasMore: page === 1 }; });
    expect(calls).toHaveLength(2); expect(result).toHaveLength(51); expect(buildThreads(result)[0].messages).toHaveLength(51);
  });
  it("accepts a genuinely empty mailbox", async () => expect(await fetchInbox(async () => ({ items: [], total: 0, page: 1, limit: 50, hasMore: false }))).toEqual([]));
  it.each([null, [], { items: [], total: "0", page: 1, limit: 50, hasMore: false }, { items: [], total: 0, page: 2, limit: 50, hasMore: false }, { items: [], total: 0, page: 1, limit: 20, hasMore: false }])("rejects malformed paging responses", async value => expect(fetchInbox(async () => value)).rejects.toThrow());
  it("rejects incomplete results instead of silently shortening a thread", async () => expect(fetchInbox(async () => ({ items: [message()], total: 2, page: 1, limit: 50, hasMore: false }))).rejects.toThrow("Incomplete"));
  it("detects changing mailbox totals", async () => { let page = 0; await expect(fetchInbox(async () => ({ items: [message({ id: `m${++page}` })], total: page === 1 ? 2 : 3, page, limit: 50, hasMore: true }))).rejects.toThrow("changed"); });
  it("detects duplicate messages across pages", async () => { let page = 0; await expect(fetchInbox(async () => ({ items: [message()], total: 2, page: ++page, limit: 50, hasMore: page === 1 }))).rejects.toThrow("changed"); });
  it("rejects a non-email row in the email feed", () => expect(() => parseMessage({ id: "sms", channel: "SMS" })).toThrow());
});

describe("conversation grouping and recipients", () => {
  it("groups an inbound email with an outbound reply by counterpart and base subject", () => {
    const rows = [message({ id: "reply", subject: "RE: Re: Proposal", createdAt: "2026-10-10T12:00:00Z" }), message({ id: "incoming", direction: "Inbound", from: "Customer <CUSTOMER@example.com>", to: "me@example.com", status: "Received", createdAt: "2026-10-10T09:00:00Z" })];
    const threads = buildThreads(rows); expect(threads).toHaveLength(1); expect(threads[0].messages.map(row => row.id)).toEqual(["incoming", "reply"]); expect(threads[0].peer).toBe("customer@example.com");
    expect(rows.map(row => row.id)).toEqual(["reply", "incoming"]);
  });
  it("keeps different correspondents and subjects separate", () => expect(buildThreads([message(), message({ id: "two", to: "other@example.com" }), message({ id: "three", subject: "Invoice" })])).toHaveLength(3));
  it("keeps unknown inbound senders separate and does not reply to the receiving mailbox", () => {
    const rows = [message({ id: "one", direction: "Inbound", from: "", to: "me@example.com" }), message({ id: "two", direction: "Inbound", from: "", to: "me@example.com" })];
    expect(buildThreads(rows)).toHaveLength(2); expect(replyRecipient(rows[0])).toBe("");
  });
  it("uses Reply-To when present", () => expect(replyRecipient(message({ direction: "Inbound", from: "sender@example.com", replyTo: "support@example.com" }))).toBe("support@example.com"));
  it("orders newest conversations first and handles invalid dates", () => expect(buildThreads([message({ id: "invalid", subject: "Old", createdAt: "bad" }), message({ id: "new", subject: "New" })]).map(thread => thread.latest.id)).toEqual(["new", "invalid"]));
  it("keeps a blank-subject reply in the same heuristic conversation", () => expect(buildThreads([message({ subject: "" }), message({ id: "reply", subject: replySubject("") })])).toHaveLength(1));
  it("normalizes repeated reply and forward prefixes", () => expect(baseSubject(" Re: FWD: re: Proposal ")).toBe("Proposal"));
  it("generates one reply prefix", () => expect(replySubject("Re: Proposal")).toBe("Re: Proposal"));
  it.each(["a@example.com,b@example.com", "a@example.com;b@example.com", "a@example.com\r\nBcc: b@example.com", "not-an-email", ""]) ("rejects unsafe or ambiguous reply addresses", value => expect(mailbox(value)).toBe(""));
  it("normalizes a display-name address", () => expect(mailbox("Customer <CUSTOMER@example.com>")).toBe("customer@example.com"));
});

describe("inbox filters and send results", () => {
  const threads = buildThreads([message({ id: "unread", subject: "Unread", direction: "Inbound", from: "customer@example.com", status: "Received", read: false }), message({ id: "tracked", subject: "Tracked", openedAt: "2026-10-10" }), message({ id: "draft", subject: "Draft", status: "Saved" })]);
  it("filters unread, sent and tracked conversations", () => { expect(filterThreads(threads, "Unread", "")).toHaveLength(1); expect(filterThreads(threads, "Sent", "")).toHaveLength(1); expect(filterThreads(threads, "Tracked", "")).toHaveLength(1); });
  it("searches message content and recipients without changing the conversation", () => { expect(filterThreads(threads, "All", "hello")).toHaveLength(3); expect(filterThreads(threads, "All", "DRAFT")[0].messages).toHaveLength(1); });
  it.each(["admin", "member", "Owner", "owner"])("allows sending for %s", role => expect(canSendEmail(role)).toBe(true));
  it.each(["viewer", undefined])("keeps %s read only", role => expect(canSendEmail(role)).toBe(false));
  it("uses the backend idempotency key and trims message fields", () => expect(emailPayload(" Customer@Example.com ", " Proposal ", " Hello ", "attempt_1")).toEqual({ channel: "Email", to: "customer@example.com", subject: "Proposal", body: "Hello", contact: "", idempotencyKey: "attempt_1" }));
  it("rejects empty bodies and invalid recipients", () => { expect(() => emailPayload("not-email", "", "Hi", "key")).toThrow(); expect(() => emailPayload("a@example.com", "", " ", "key")).toThrow(); });
  it("rejects a send acknowledgement for another payload", () => expect(() => assertEmailResponse(message({ body: "Different" }), emailPayload("customer@example.com", "Proposal", "Hello", "key"))).toThrow("could not be confirmed"));
  it.each(["Saved", "Queued", "Failed"])("does not claim a %s result was sent", status => expect(deliveryLabel(message({ status }))).not.toBe("Email sent"));
  it("recognizes the provider's Sent acknowledgement", () => expect(deliveryLabel(assertEmailResponse(message(), emailPayload("customer@example.com", "Proposal", "Hello", "key")))).toBe("Email sent"));
});
