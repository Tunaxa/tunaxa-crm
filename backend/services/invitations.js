// Team invitation contract (P2-BE1-05).
//
// Invitations onboard teammates by email. The raw secret is a 256-bit random
// token that is only ever handed to the mailer; the store keeps a SHA-256 hash
// of it, so a database (or JSON-store) leak does not yield usable join links and
// listing an invitation cannot accidentally echo its secret.
//
// This module is deliberately free of Express and store concerns: it owns token
// generation/hashing, the expiry clock, the derived status and the public
// (secret-free) projection. The route layer owns persistence and account
// creation, and the tests can exercise the pure helpers directly.

import crypto from 'node:crypto';

// Authorization roles the rest of the app actually enforces (see
// middleware/rbac.js and PATCH /api/users/:id/role). `Owner` is intentionally
// excluded: an owner is created with the workspace, not invited into it.
export const INVITE_ROLES = ['admin', 'member', 'viewer'];
export const DEFAULT_INVITE_ROLE = 'member';

// Stored lifecycle. `expired` is deliberately *not* stored: it is derived from
// the clock so that simply listing invitations never forces a write.
export const INVITE_STATUSES = ['pending', 'accepted', 'revoked', 'expired'];

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

export function hashInviteToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Returns a fresh raw token (for the email / one-time API response) together
// with the hash that is the only thing persisted.
export function mintInviteToken() {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  return { token, tokenHash: hashInviteToken(token) };
}

export function isInviteTokenFormat(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

export function inviteExpiresAt(from = Date.now()) {
  return new Date(from + INVITE_TTL_MS).toISOString();
}

export function inviteIsExpired(invite, at = Date.now()) {
  if (!invite || !invite.expiresAt) return false;
  const expires = Date.parse(invite.expiresAt);
  return Number.isFinite(expires) && expires <= at;
}

// Resolves the status a client should see: accepted/revoked are terminal and
// stored, everything else is `pending` until the expiry clock lapses it.
export function inviteStatus(invite, at = Date.now()) {
  if (!invite) return 'expired';
  if (invite.status === 'accepted' || invite.status === 'revoked') return invite.status;
  return inviteIsExpired(invite, at) ? 'expired' : 'pending';
}

export function inviteIsPending(invite, at = Date.now()) {
  return inviteStatus(invite, at) === 'pending';
}

// Constant-time hash comparison. The candidate is hashed first so both sides
// are always the same 32 bytes, which keeps the timing independent of where a
// partial match diverges.
export function findInviteByToken(db, token) {
  if (!isInviteTokenFormat(token)) return null;
  const candidate = Buffer.from(hashInviteToken(token), 'hex');
  for (const invite of db.invitations || []) {
    if (typeof invite.tokenHash !== 'string') continue;
    const stored = Buffer.from(invite.tokenHash, 'hex');
    if (stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate)) return invite;
  }
  return null;
}

export function normalizeInviteRole(role) {
  if (role === undefined || role === null || role === '') return DEFAULT_INVITE_ROLE;
  const value = String(role).trim().toLowerCase();
  return INVITE_ROLES.includes(value) ? value : null;
}

export function normalizeInviteEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

// The only projection ever sent to a client for a stored invitation. It never
// contains `tokenHash` (nor a raw token) so list endpoints cannot leak secrets.
export function sanitizeInvite(invite, at = Date.now()) {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: inviteStatus(invite, at),
    invitedBy: invite.invitedBy || null,
    invitedByName: invite.invitedByName || '',
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
    updatedAt: invite.updatedAt || invite.createdAt,
    acceptedAt: invite.acceptedAt || null,
    revokedAt: invite.revokedAt || null,
    resendCount: invite.resendCount || 0,
    lastSentAt: invite.lastSentAt || null,
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

export function joinUrlFor(publicBaseUrl, token) {
  const base = String(publicBaseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const origin = base || 'http://localhost:5173';
  return `${origin}/accept-invite?token=${encodeURIComponent(token)}`;
}

export function buildInviteEmail({ invite, joinUrl, inviterName, workspaceName } = {}) {
  const workspace = workspaceName || 'Tunaxa';
  const inviter = inviterName || 'A teammate';
  const subject = `${inviter} invited you to join ${workspace}`;
  const text = [
    `${inviter} invited you to join the ${workspace} workspace as ${invite.role}.`,
    '',
    `Accept your invitation: ${joinUrl}`,
    '',
    `This invitation expires on ${invite.expiresAt}. If you were not expecting it, you can ignore this email.`,
  ].join('\n');
  const html = [
    `<p><strong>${escapeHtml(inviter)}</strong> invited you to join the <strong>${escapeHtml(workspace)}</strong> workspace as <strong>${escapeHtml(invite.role)}</strong>.</p>`,
    `<p><a href="${escapeHtml(joinUrl)}">Accept your invitation</a></p>`,
    `<p>This invitation expires on ${escapeHtml(invite.expiresAt)}.</p>`,
  ].join('\n');
  return { subject, text, html };
}
