import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { id, now, hashPassword, publicUser, auditEntry } from '../helpers.js';
import { validate, InviteSchema, AcceptInviteSchema } from '../services/validate.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { issueSessionPair, setRefreshCookie } from '../services/refreshTokens.js';
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

const tenantOf = (req) => req.user?.workspaceId || req.user?.workspace_id || 'default';

const acceptLimiter = createRateLimiter({ windowMs: 60_000, max: 20, prefix: 'invite-accept' });
const validateLimiter = createRateLimiter({ windowMs: 60_000, max: 30, prefix: 'invite-validate' });

const MAX_OUTBOX = 500;

function findUserByEmail(db, email) {
  const normalized = normalizeInviteEmail(email);
  return (db.users || []).find((user) => normalizeInviteEmail(user.email) === normalized) || null;
}

function teamHasEmail(db, email) {
  const normalized = normalizeInviteEmail(email);
  return (db.team || []).some((member) => normalizeInviteEmail(member.email) === normalized);
}

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
  if (result && result.error && result.error !== 'Email delivery failed') {
    console.error('[invitations] email delivery failed:', result.error);
    result = { ...result, error: 'Email delivery failed' };
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
  return {
    sent: Boolean(result.delivered),
    status: result.status || 'Unknown',
    ...(result.error ? { error: result.error } : {}),
  };
}

export default function registerInvitationRoutes(app) {
  const createInvite = async (req, res) => {
    const email = normalizeInviteEmail(req.body.email);
    const { role } = req.body;
    const workspaceId = tenantOf(req);

    const prepared = await mutateDb((db) => {
      db.invitations = db.invitations || [];
      if (findUserByEmail(db, email) || teamHasEmail(db, email)) {
        return { status: 409, error: 'A user with this email already exists' };
      }

      const existing = db.invitations.find(
        (invite) =>
          normalizeInviteEmail(invite.email) === email &&
          invite.status === 'pending' &&
          (invite.workspaceId || 'default') === workspaceId,
      );
      const { token, tokenHash } = mintInviteToken();
      const timestamp = now();

      if (existing) {
        existing.tokenHash = tokenHash;
        existing.role = role;
        existing.workspaceId = workspaceId;
        existing.expiresAt = inviteExpiresAt();
        existing.updatedAt = timestamp;
        existing.lastSentAt = timestamp;
        existing.resendCount = (existing.resendCount || 0) + 1;
        existing.invitedBy = req.user.id;
        existing.invitedByName = req.user.name;
        return { created: false, record: existing, rawToken: token, workspaceId };
      }

      const invite = {
        id: id('inv'),
        email,
        role,
        tokenHash,
        status: 'pending',
        invitedBy: req.user.id,
        invitedByName: req.user.name,
        workspaceId,
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
      return { created: true, record: invite, rawToken: token, workspaceId };
    });

    if (prepared.error) return res.status(prepared.status).json({ error: prepared.error });

    const summary = sanitizeInvite(prepared.record);
    const delivery = await deliverInviteEmail(prepared.record, prepared.rawToken, req.user.name);
    broadcast('invitation.created', { invite: summary }, prepared.workspaceId);
    res.status(prepared.created ? 201 : 200).json({
      invite: summary,
      email: emailSummary(delivery),
      joinUrl: delivery.joinUrl,
    });
  };

  const listInvites = async (req, res) => {
    const workspaceId = tenantOf(req);
    const db = await readDb();
    const invites = (db.invitations || [])
      .filter((invite) => (invite.workspaceId || 'default') === workspaceId)
      .slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .map((invite) => sanitizeInvite(invite));
    res.json({ invites, count: invites.length });
  };

  app.post('/api/team/invites', auth, requireAdmin, validate(InviteSchema), createInvite);
  app.post('/api/users/invite', auth, requireAdmin, validate(InviteSchema), createInvite);
  app.get('/api/team/invites', auth, requireAdmin, listInvites);
  app.get('/api/users/invites', auth, requireAdmin, listInvites);

  app.post('/api/team/invites/:id/resend', auth, requireAdmin, async (req, res) => {
    const workspaceId = tenantOf(req);
    const prepared = await mutateDb((db) => {
      db.invitations = db.invitations || [];
      const invite = db.invitations.find((item) => item.id === req.params.id);
      if (!invite || (invite.workspaceId || 'default') !== workspaceId) {
        return { status: 404, error: 'Invitation not found' };
      }
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
      return { record: invite, rawToken: token, workspaceId };
    });

    if (prepared.error) return res.status(prepared.status).json({ error: prepared.error });

    const summary = sanitizeInvite(prepared.record);
    const delivery = await deliverInviteEmail(prepared.record, prepared.rawToken, req.user.name);
    broadcast('invitation.resent', { invite: summary }, prepared.workspaceId);
    res.json({ invite: summary, email: emailSummary(delivery), joinUrl: delivery.joinUrl });
  });

  const revokeInvite = async (req, res) => {
    const workspaceId = tenantOf(req);
    const result = await mutateDb((db) => {
      db.invitations = db.invitations || [];
      const invite = db.invitations.find((item) => item.id === req.params.id);
      if (!invite || (invite.workspaceId || 'default') !== workspaceId) {
        return { status: 404, error: 'Invitation not found' };
      }
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
      return { invite: sanitizeInvite(invite), workspaceId };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    broadcast('invitation.revoked', { invite: result.invite }, result.workspaceId);
    res.json({ invite: result.invite });
  };

  app.post('/api/team/invites/:id/revoke', auth, requireAdmin, revokeInvite);
  app.delete('/api/team/invites/:id', auth, requireAdmin, revokeInvite);

  app.get('/api/invitations/:token', validateLimiter, async (req, res) => {
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

    let refreshToken = null;
    const outcome = await mutateDb((db) => {
      db.invitations = db.invitations || [];
      const invite = findInviteByToken(db, token);
      if (!invite) return { status: 404, error: 'Invitation not found' };

      const status = inviteStatus(invite);
      if (status === 'accepted' || status === 'revoked') {
        return { status: 404, error: 'Invitation not found' };
      }
      if (status === 'expired') return { status: 400, error: 'Invitation has expired' };
      if (findUserByEmail(db, invite.email) || teamHasEmail(db, invite.email)) {
        return { status: 409, error: 'A user with this email already exists' };
      }

      const workspaceId = invite.workspaceId || 'default';
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

      const pair = issueSessionPair(db, user.id);
      refreshToken = pair.refreshToken;

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
        token: pair.accessToken,
        refreshToken: pair.refreshToken,
        expiresIn: pair.expiresIn,
        user: publicUser(user),
        invite: sanitizeInvite(invite),
      };
    });

    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    if (refreshToken) setRefreshCookie(res, refreshToken);
    broadcast('user.created', { user: outcome.user }, outcome.workspaceId);
    res.status(201).json({
      token: outcome.token,
      refreshToken: outcome.refreshToken,
      expiresIn: outcome.expiresIn,
      user: outcome.user,
      invite: outcome.invite,
    });
  };

  app.post('/api/invitations/accept', acceptLimiter, validate(AcceptInviteSchema), acceptInvite);
  app.post('/api/auth/accept-invite', acceptLimiter, validate(AcceptInviteSchema), acceptInvite);
}
