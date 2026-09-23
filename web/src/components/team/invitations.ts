export type PendingInvitation = {
  id: string;
  email: string;
  expiresAt: string;
  createdAt: string;
};

type InvitationRecord = Record<string, unknown>;

function invitationRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const response = payload as InvitationRecord;
  if (Array.isArray(response.items)) return response.items;
  if (Array.isArray(response.invites)) return response.invites;
  return [];
}

export function normalizeInvitations(payload: unknown): PendingInvitation[] {
  return invitationRows(payload).flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const invitation = value as InvitationRecord;
    const email = String(invitation.email || "").trim().toLowerCase();
    if (!email) return [];

    return [
      {
        id: String(invitation.id || invitation.inviteId || email || index),
        email,
        expiresAt: String(
          invitation.expiresAt ||
            invitation.expires_at ||
            invitation.expiry ||
            "",
        ),
        createdAt: String(
          invitation.createdAt || invitation.created_at || "",
        ),
      },
    ];
  });
}

export function invitationIsExpired(expiresAt: string, now = Date.now()) {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry <= now;
}
