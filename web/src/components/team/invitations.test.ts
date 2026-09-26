import { describe, expect, it } from "vitest";
import { invitationIsExpired, normalizeInvitations } from "./invitations";

describe("team invitations", () => {
  it("normalizes array and wrapped API responses", () => {
    expect(
      normalizeInvitations([
        {
          id: "invite-1",
          email: " Person@Example.com ",
          expires_at: "2026-10-01T10:00:00.000Z",
        },
      ]),
    ).toEqual([
      {
        id: "invite-1",
        email: "person@example.com",
        expiresAt: "2026-10-01T10:00:00.000Z",
        createdAt: "",
      },
    ]);

    expect(
      normalizeInvitations({
        invites: [{ inviteId: "invite-2", email: "two@example.com" }],
      }),
    ).toHaveLength(1);
  });

  it("ignores malformed records", () => {
    expect(normalizeInvitations({ items: [null, {}, { id: "missing-email" }] })).toEqual([]);
    expect(normalizeInvitations(null)).toEqual([]);
  });

  it("detects expired invitations without treating an unknown expiry as expired", () => {
    const now = Date.parse("2026-09-23T12:00:00.000Z");
    expect(invitationIsExpired("2026-09-23T11:59:59.000Z", now)).toBe(true);
    expect(invitationIsExpired("2026-09-23T12:00:01.000Z", now)).toBe(false);
    expect(invitationIsExpired("", now)).toBe(false);
  });
});
