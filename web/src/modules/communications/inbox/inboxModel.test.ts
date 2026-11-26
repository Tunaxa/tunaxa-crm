import { describe, expect, it } from "vitest";
import { canManageRecords } from "../../../components/records/rbac";
import { sanitizeFieldKey } from "../../../components/records/urlSecurity";
import {
  assertEmailResponse,
  baseSubject,
  buildEmailPayload,
  buildThreads,
  canSendEmail,
  deliveryLabel,
  fetchInbox,
  filterThreads,
  groupMessagesIntoThreads,
  mailbox,
  normalizeDeliveryStatus,
  parseEmailTemplates,
  parseMessage,
  replyRecipient,
  replySubject,
} from "./inboxModel";

const message = (value: Record<string, unknown> = {}) =>
  parseMessage({
    id: "one",
    channel: "Email",
    to: "customer@example.com",
    subject: "Proposal",
    body: "Hello",
    direction: "Outbound",
    status: "Sent",
    read: true,
    createdAt: "2026-10-10T10:00:00Z",
    ...value,
  });

const envelope = (rows: unknown[], total: number, page: number, limit = 50) => ({
  data: rows,
  total,
  page,
  limit,
});

describe("complete inbox loading", () => {
  it("loads every { data, total, page, limit } page before grouping", async () => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      message({ id: `m${index}` }),
    );
    const calls: string[] = [];
    const result = await fetchInbox(async (path) => {
      calls.push(path);
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
      return envelope(rows.slice((page - 1) * 50, page * 50), rows.length, page);
    });
    expect(calls).toEqual([
      "/messages?type=email&page=1&limit=50",
      "/messages?type=email&page=2&limit=50",
    ]);
    expect(result).toHaveLength(51);
    expect(groupMessagesIntoThreads(result)[0].messages).toHaveLength(51);
  });

  it("computes hasMore from page, limit and total", async () => {
    const calls: number[] = [];
    await fetchInbox(async (path) => {
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
      calls.push(page);
      return envelope([message({ id: `m${page}` })], 1, page);
    });
    expect(calls).toEqual([1]);
  });

  it("accepts a genuinely empty mailbox", async () => {
    expect(
      await fetchInbox(async () => envelope([], 0, 1)),
    ).toEqual([]);
  });

  it.each([
    null,
    [],
    envelope([], "0" as unknown as number, 1),
    envelope([], 0, 2),
    envelope([], 0, 1, 20),
    envelope([], 1, 1),
    envelope([], 25_001, 1),
    { items: [], total: 0, page: 1, limit: 50, hasMore: false },
  ])("rejects malformed paging responses", async (value) => {
    await expect(fetchInbox(async () => value)).rejects.toThrow();
  });

  it("rejects changing totals and duplicate messages", async () => {
    let page = 0;
    await expect(
      fetchInbox(async () => {
        page += 1;
        return envelope(
          [message({ id: `m${page}` })],
          page === 1 ? 51 : 52,
          page,
        );
      }),
    ).rejects.toThrow("changed");

    let duplicatePage = 0;
    await expect(
      fetchInbox(async () => {
        duplicatePage += 1;
        return envelope([message()], 51, duplicatePage);
      }),
    ).rejects.toThrow("changed");
  });
});

describe("message parsing and hardening", () => {
  it("keeps untrusted text as text instead of interpreting markup", () => {
    const body = '<script>alert(1)</script><img src=x onerror="alert(2)">';
    expect(parseMessage({ id: "xss", channel: "Email", body }).body).toBe(body);
    expect(() => parseMessage({ id: "sms", channel: "SMS" })).toThrow();
  });

  it("normalizes delivery statuses conservatively", () => {
    expect(normalizeDeliveryStatus(" sent ")).toBe("Sent");
    expect(normalizeDeliveryStatus("received")).toBe("received");
    expect(message({ status: "queued" }).status).toBe("Queued");
  });

  it.each([
    "a@example.com,b@example.com",
    "a@example.com;b@example.com",
    "a@example.com\r\nBcc: b@example.com",
    "a@example.com\nBcc: b@example.com",
    "a@example.com\tBcc: b@example.com",
    "not-an-email",
    "",
  ])("rejects unsafe recipient %s", (value) => {
    expect(mailbox(value)).toBe("");
    expect(() => buildEmailPayload(value, "Subject", "Body", "key")).toThrow();
  });

  it("normalizes a display-name recipient", () => {
    expect(mailbox("Customer <CUSTOMER@example.com>")).toBe(
      "customer@example.com",
    );
  });

  it("bounds subject and body lengths and rejects subject injection", () => {
    expect(
      buildEmailPayload("a@example.com", "x".repeat(255), "y", "key").subject,
    ).toHaveLength(255);
    expect(() =>
      buildEmailPayload("a@example.com", "x".repeat(256), "y", "key"),
    ).toThrow(/255/);
    expect(() =>
      buildEmailPayload("a@example.com", "Subject\r\nBcc: b@example.com", "y", "key"),
    ).toThrow(/Subject/);
    expect(
      buildEmailPayload("a@example.com", "Subject", "y".repeat(20000), "key").body,
    ).toHaveLength(20000);
    expect(() =>
      buildEmailPayload("a@example.com", "Subject", "y".repeat(20001), "key"),
    ).toThrow(/20000/);
  });

  it("never copies prototype-polluting keys from untrusted responses", () => {
    const hostile = JSON.parse(
      '{"id":"m1","channel":"Email","__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}',
    ) as Record<string, unknown>;
    const parsed = parseMessage(hostile);
    expect(parsed.id).toBe("m1");
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(sanitizeFieldKey(key)).toBeNull();
    }
  });
});

describe("conversation grouping and templates", () => {
  it("groups an inbound email with an outbound reply", () => {
    const rows = [
      message({
        id: "reply",
        subject: "RE: Re: Proposal",
        createdAt: "2026-10-10T12:00:00Z",
      }),
      message({
        id: "incoming",
        direction: "Inbound",
        from: "Customer <CUSTOMER@example.com>",
        to: "me@example.com",
        status: "Received",
        createdAt: "2026-10-10T09:00:00Z",
      }),
    ];
    const threads = buildThreads(rows);
    expect(threads).toHaveLength(1);
    expect(threads[0].messages.map((row) => row.id)).toEqual([
      "incoming",
      "reply",
    ]);
    expect(threads[0].peer).toBe("customer@example.com");
  });

  it("keeps unknown senders separate and uses Reply-To", () => {
    const rows = [
      message({ id: "one", direction: "Inbound", from: "", to: "me@example.com" }),
      message({ id: "two", direction: "Inbound", from: "", to: "me@example.com" }),
    ];
    expect(buildThreads(rows)).toHaveLength(2);
    expect(replyRecipient(rows[0])).toBe("");
    expect(
      replyRecipient(
        message({
          direction: "Inbound",
          from: "sender@example.com",
          replyTo: "support@example.com",
        }),
      ),
    ).toBe("support@example.com");
  });

  it("normalizes reply prefixes and filters threads", () => {
    expect(baseSubject(" Re: FWD: re: Proposal ")).toBe("Proposal");
    expect(replySubject("Re: Proposal")).toBe("Re: Proposal");
    const threads = buildThreads([
      message({
        id: "unread",
        subject: "Unread",
        direction: "Inbound",
        from: "customer@example.com",
        status: "Received",
        read: false,
      }),
      message({ id: "tracked", subject: "Tracked", openedAt: "2026-10-10" }),
    ]);
    expect(filterThreads(threads, "Unread", "")).toHaveLength(1);
    expect(filterThreads(threads, "Sent", "")).toHaveLength(1);
    expect(filterThreads(threads, "Tracked", "")).toHaveLength(1);
  });

  it("parses paginated and bare-array template responses", () => {
    const row = { id: "t1", name: "Follow up", subject: "Hello", body: "Hi" };
    expect(
      parseEmailTemplates(envelope([row], 1, 1, 25)),
    ).toEqual([row]);
    expect(parseEmailTemplates([row])).toEqual([row]);
    expect(() => parseEmailTemplates({ items: [row] })).toThrow();
  });
});

describe("send acknowledgements and access", () => {
  const payload = buildEmailPayload(
    "customer@example.com",
    "Proposal",
    "Hello",
    "key",
  );

  it("uses the idempotency key and trims message fields", () => {
    expect(
      buildEmailPayload(
        " Customer@Example.com ",
        " Proposal ",
        " Hello ",
        "attempt_1",
      ),
    ).toEqual({
      channel: "Email",
      to: "customer@example.com",
      subject: "Proposal",
      body: "Hello",
      contact: "",
      idempotencyKey: "attempt_1",
    });
  });

  it("rejects acknowledgements for another payload", () => {
    expect(() =>
      assertEmailResponse(message({ body: "Different" }), payload),
    ).toThrow("could not be confirmed");
    expect(assertEmailResponse(message(), payload).status).toBe("Sent");
  });

  it.each(["Saved", "Queued", "Failed"])(
    "does not claim a %s result was sent",
    (status) => {
      expect(deliveryLabel(message({ status }))).not.toBe("Email sent");
    },
  );

  it.each(["owner", "Owner", "admin", "member"])(
    "allows sending for %s with rbac parity",
    (role) => {
      expect(canSendEmail(role)).toBe(true);
      expect(canSendEmail(role)).toBe(canManageRecords(role));
    },
  );

  it.each(["viewer", undefined])(
    "keeps %s read only with rbac parity",
    (role) => {
      expect(canSendEmail(role)).toBe(false);
      expect(canSendEmail(role)).toBe(canManageRecords(role));
    },
  );
});
