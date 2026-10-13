// Team invitations & role assignment (P2-BE1-05).
//
//   POST   /api/team/invites            admin   create (or refresh) an invite
//   GET    /api/team/invites            auth    list invites (never a secret)
//   POST   /api/team/invites/:id/resend admin   new token + expiry + email
//   POST   /api/team/invites/:id/revoke admin   revoke (soft delete)
//   DELETE /api/team/invites/:id        admin   revoke (alias)
//   GET    /api/invitations/:token      public  validate a token, never consume
//   POST   /api/invitations/accept      public  accept: create user + session
//   POST   /api/auth/accept-invite      public  alias of the accept route
//
// The pre-existing Team page also calls `POST /api/users/invite` and
// `GET /api/users/invites`; those two paths are kept as aliases of create/list
// so the shipped UI keeps working without a paired frontend change.
//
// Invitations live in the JSON store (`backend/store.js`) — the same source of
// truth middleware/auth.js reads to build sessions and `req.user` — so they
// survive a restart. Only a SHA-256 hash of the join token is stored; the raw
// token is handed to the mailer and, on create/resend, returned once to the
// authenticated admin so the link is usable when SMTP is not configured.
//
// Registered ahead of the generic `/api/:resource` router: `team` is a served
// resource, so `/api/team/invites` would otherwise be answered as the
// two-segment `/api/team/:id` route with `id = "invites"`.

import crypto from 'node:crypto';
import { readDb, mutateDb } from '../store.js';
import { auth, sessionExpiresAt } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { id, now, hashPassword, publicUser, auditEntry } from '../helpers.js';
import { validate, InviteSchema, AcceptInviteSchema } from '../services/validate.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { getSettings } from '../services/config.js';
import { sendEmail } from '../services/email.js';
import { broadcast } from './sse.js';
import {
  buildInviteEmail,
  findInviteByToken,
  inviteExpiresAt,
  inviteStatus,
  isInviteTokenFormat,
  joinUrlFor,
  mintInviteToken,
  normalizeInviteEmail,
  sanitizeInvite,
} from '../services/invitations.js';

// Account creation is the sensitive step (it mints a session), so it gets the
// same tight budget as login. Token validation itself is safe: the token space
// is 2^256.
const acceptLimiter = createRateLimiter({ windowMs: 60_000, max: 20, prefix: 'invite-accept' });

// The outbox is a development/audit convenience, not a queue: keep it bounded
// so a long-lived workspace cannot grow the JSON store without limit.
const MAX_OUTBOX = 500;

function findUserByEmail(db, email) {
  const normalized = normalizeInviteEmail(email);
  return (db.users || []).find((user) => normalizeInviteEmail(user.email) === normalized) || null;
}

function teamHasEmail(db, email) {
  const normalized = normalizeInviteEmail(email);
  return (db.team || []).some((member) => normalizeInviteEmail(member.email) === normalized);
}

// Appends the dispatched message to `db.emailOutbox` regardless of whether the
// SMTP transport accepted it, so "was an invite sent?" is answerable and the
// join link is recoverable in local development. Runs in its own mutation so a
// slow/failed mailer never holds the store write queue.
async function deliverInviteEmail(invite, token, inviterName) {
  const settings = await getSettings();
  const joinUrl = joinUrlFor(settings.publicBaseUrl, token);
  const message = buildInviteEmail({
    invite,
    joinUrl,
    inviterName,
    workspaceName: settings.workspaceName,
  });
  let result;
  try {
    result = await sendEmail(settings, { to: invite.email, ...message });
  } catch (error) {
    console.error('[invitations] email delivery threw:', error);
    result = { delivered: false, status: 'Failed', error: 'Email delivery failed' };
  }
  await mutateDb((db) => {
    const outbox = db.emailOutbox || (db.emailOutbox = []);
    outbox.unshift({
      id: id('mail'),
      to: invite.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
      status: result.status || 'Unknown',
      delivered: Boolean(result.delivered),
      error: result.error || '',
      inviteId: invite.id,
      createdAt: now(),
    });
    if (outbox.length > MAX_OUTBOX) outbox.length = MAX_OUTBOX;
  });
  return { ...result, joinUrl };
}

function emailSummary(result) {
  if (result.error) {
    // Mailer messages can carry SMTP host/account detail; keep the real
    // cause in the server log and tell the client only that delivery failed.
    console.error('[invitations] email delivery failed:', result.error);
  }
  return {
    sent: Boolean(result.delivered),
    status: result.status || 'Unknown',
    ...(result.error ? { error: 'Email delivery failed' } : {}),
  };
}

export default function registerInvitationRoutes(app) {
  const createInvite = async (req, res) => {
    const email = normalizeInviteEmail(req.body.email);
    const { role } = req.body;

    const prepared = await mutateDb((db) => {
      db.invitations = db.invitations || [];
      if (findUserByEmail(db, email) || teamHasEmail(db, email)) {
        return { status: 409, error: 'A user with this email already exists' };
      }

      // Reuse an existing pending record instead of duplicating rows for one
      // address. Expiry is derived, so an out-of-date pending invite is simply
      // refreshed with a new token and window.
      const existing = db.invitations.find(
        (invite) => normalizeInviteEmail(invite.email) === email && invite.status === 'pending',
      );
      const { token, tokenHash } = mintInviteToken();
      const timestamp = now();

      if (existing) {
        existing.tokenHash = tokenHash;
        existing.role = role;
        existing.expiresAt = inviteExpiresAt();
        existing.updatedAt = timestamp;
        existing.lastSentAt = timestamp;
        existing.resendCount = (existing.resendCount || 0) + 1;
        existing.invitedBy = req.user.id;
        existing.invitedByName = req.user.name;
        return { created: false, record: existing, rawToken: token };
      }

      const invite = {
        id: id('inv'),
        email,
        role,
        tokenHash,
        status: 'pending',
        invitedBy: req.user.id,
        invitedByName: req.user.name,
        workspaceId: req.user.workspaceId || null,
        expiresAt: inviteExpiresAt(),
        resendCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSentAt: timestamp,
        acceptedAt: null,
        acceptedBy: null,
        revokedAt: null,
        revokedBy: null,
      };
      db.invitations.unshift(invite);
      db.audit.unshift(
        auditEntry({ action: `Invited ${email} as ${role}`, actor: req.user.name, req, resourceId: invite.id }),
      );
      return { created: true, record: invite, rawToken: token };
    });

    if (prepared.error) return res.status(prepared.status).json({ error: prepared.error });

    const summary = sanitizeInvite(prepared.record);
    const delivery = await deliverInviteEmail(prepared.record, prepared.rawToken, req.user.name);
    broadcast('invitation.created', { invite: summary }, req.user.workspaceId || 'default');
    res.status(prepared.created ? 201 : 200).json({
      invite: summary,
      email: emailSummary(delivery),
      joinUrl: delivery.joinUrl,
    });
  };

  const listInvites = async (req, res) => {
    const db = await readDb();
    const invites = (db.invitations || [])
      .slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .map((invite) => sanitizeInvite(invite));
    res.json({ invites, count: invites.length });
  };

  app.post('/api/team/invites', auth, requireAdmin, validate(InviteSchema), createInvite);
  // The Team page in `web/src/App.tsx` (and the onboarding wizard) predates this
  // router and calls `/api/users/invite` / `/api/users/invites`. Keep those paths
  // as aliases so the existing UI works without a paired frontend change; they
  // share the exact same handlers and therefore the same admin-only guard.
  app.post('/api/users/invite', auth, requireAdmin, validate(InviteSchema), createInvite);
  app.get('/api/team/invites', auth, listInvites);
  app.get('/api/users/invites', auth, listInvites);

  app.post('/api/team/invites/:id/resend', auth, requireAdmin, async (req, res) => {
    const prepared = await mutateDb((db) => {
      db.invitations = db.invitations || [];
      const invite = db.invitations.find((item) => item.id === req.params.id);
      if (!invite) return { status: 404, error: 'Invitation not found' };
      if (invite.status === 'accepted') return { status: 400, error: 'Invitation already accepted' };
      if (invite.status === 'revoked') return { status: 400, error: 'Invitation has been revoked' };

      const { token, tokenHash } = mintInviteToken();
      invite.tokenHash = tokenHash;
      invite.status = 'pending';
      invite.expiresAt = inviteExpiresAt();
      invite.updatedAt = now();
      invite.lastSentAt = invite.updatedAt;
      invite.resendCount = (invite.resendCount || 0) + 1;
      invite.invitedBy = req.user.id;
      invite.invitedByName = req.user.name;
      return { record: invite, rawToken: token };
    });

    if (prepared.error) return res.status(prepared.status).json({ error: prepared.error });

    const summary = sanitizeInvite(prepared.record);
    const delivery = await deliverInviteEmail(prepared.record, prepared.rawToken, req.user.name);
    broadcast('invitation.resent', { invite: summary }, req.user.workspaceId || 'default');
    res.json({ invite: summary, email: emailSummary(delivery), joinUrl: delivery.joinUrl });
  });

  const revokeInvite = async (req, res) => {
    const result = await mutateDb((db) => {
      db.invitations = db.invitations || [];
      const invite = db.invitations.find((item) => item.id === req.params.id);
      if (!invite) return { status: 404, error: 'Invitation not found' };
      if (invite.status === 'accepted') {
        return { status: 400, error: 'Accepted invitations cannot be revoked' };
      }
      if (invite.status !== 'revoked') {
        invite.status = 'revoked';
        invite.revokedAt = now();
        invite.revokedBy = req.user.id;
        invite.updatedAt = invite.revokedAt;
        db.audit.unshift(
          auditEntry({
            action: `Revoked invitation for ${invite.email}`,
            actor: req.user.name,
            req,
            resourceId: invite.id,
          }),
        );
      }
      return { invite: sanitizeInvite(invite) };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    broadcast('invitation.revoked', { invite: result.invite }, req.user.workspaceId || 'default');
    res.json({ invite: result.invite });
  };

  app.post('/api/team/invites/:id/revoke', auth, requireAdmin, revokeInvite);
  app.delete('/api/team/invites/:id', auth, requireAdmin, revokeInvite);

  app.get('/api/invitations/:token', async (req, res) => {
    const { token } = req.params;
    if (!isInviteTokenFormat(token)) return res.status(404).json({ error: 'Invitation not found' });
    const db = await readDb();
    const invite = findInviteByToken(db, token);
    if (!invite) return res.status(404).json({ error: 'Invitation not found' });

    const status = inviteStatus(invite);
    if (status === 'accepted' || status === 'revoked') {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    res.json({
      valid: status === 'pending',
      expired: status === 'expired',
      status,
      email: invite.email,
      role: invite.role,
      invitedByName: invite.invitedByName || '',
      expiresAt: invite.expiresAt,
    });
  });

  const acceptInvite = async (req, res) => {
    const { token, name, password } = req.body;
    if (!isInviteTokenFormat(token)) return res.status(404).json({ error: 'Invitation not found' });

    const outcome = await mutateDb((db) => {
      db.invitations = db.invitations || [];
      const invite = findInviteByToken(db, token);
      if (!invite) return { status: 404, error: 'Invitation not found' };

      const status = inviteStatus(invite);
      if (status === 'accepted' || status === 'revoked') {
        return { status: 404, error: 'Invitation not found' };
      }
      if (status === 'expired') return { status: 400, error: 'Invitation has expired' };
      if (findUserByEmail(db, invite.email)) {
        return { status: 409, error: 'A user with this email already exists' };
      }

      const workspaceId = invite.workspaceId || id('ws');
      const user = {
        id: id('usr'),
        name: String(name).trim(),
        email: invite.email,
        password: hashPassword(password),
        role: invite.role,
        workspaceId,
        createdAt: now(),
      };
      db.users.push(user);
      db.team.push({
        id: id('team'),
        name: user.name,
        email: user.email,
        role: invite.role,
        status: 'Active',
        createdAt: now(),
      });

      const sessionToken = crypto.randomBytes(32).toString('hex');
      db.sessions.push({
        token: sessionToken,
        userId: user.id,
        createdAt: now(),
        expiresAt: sessionExpiresAt(),
      });

      invite.status = 'accepted';
      invite.acceptedAt = now();
      invite.acceptedBy = user.id;
      invite.updatedAt = invite.acceptedAt;
      db.audit.unshift(
        auditEntry({
          action: `Accepted invitation (${invite.role}) for ${invite.email}`,
          actor: user.name,
          req,
          resourceId: invite.id,
        }),
      );

      return {
        ok: true,
        workspaceId,
        token: sessionToken,
        user: publicUser(user),
        invite: sanitizeInvite(invite),
      };
    });

    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    broadcast('user.created', { user: outcome.user }, outcome.workspaceId);
    res.status(201).json({ token: outcome.token, user: outcome.user, invite: outcome.invite });
  };

  app.post('/api/invitations/accept', acceptLimiter, validate(AcceptInviteSchema), acceptInvite);
  app.post('/api/auth/accept-invite', acceptLimiter, validate(AcceptInviteSchema), acceptInvite);
}
