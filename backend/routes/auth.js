import crypto from 'node:crypto';
import { readDb, mutateDb } from '../store.js';
import { auth, sessionExpiresAt, sessionIsExpired } from '../middleware/auth.js';
import { hashPassword, verifyPassword, publicUser, now, id, paginateAndSort } from '../helpers.js';
import { validate, SetupSchema, LoginSchema } from '../services/validate.js';
import { createRateLimiter } from '../services/rateLimit.js';
import {
  clearRefreshCookie,
  findRefreshSession,
  issueSessionPair,
  readPresentedToken,
  revokeAllUserSessions,
  revokeRefreshFamily,
  rotateLegacyAccessToken,
  rotateRefreshToken,
  setRefreshCookie,
} from '../services/refreshTokens.js';
import { requireAdmin } from '../middleware/rbac.js';
import { broadcast } from './sse.js';
import { getSettings } from '../services/config.js';
import { sendEmail } from '../services/smtp.js';

// Credential endpoints are bounded per IP. Login is 10 attempts per 15 minutes
// rather than per minute: a 10/minute window let an attacker try 10 passwords
// every minute indefinitely, which is 14,400 guesses a day against a short
// password. 10 per 15 minutes is 960 a day, and the window is long enough that
// a legitimate user who fat-fingers a password a few times is not locked out.
const authLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 10, prefix: 'auth' });
// Refresh is unauthenticated and accepts a raw credential, so it gets its own
// bucket rather than sharing login's budget -- a legitimate client refreshing
// should not be able to lock itself out of signing in, and a brute-force run
// against refresh should not consume login's allowance either.
const refreshLimiter = createRateLimiter({ windowMs: 60_000, max: 30, prefix: 'refresh' });
const inviteLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 10, prefix: 'invite' });

const DEFAULT_PREFERENCES = { theme: 'light', sidebarCollapsed: false, tablePageSize: 25 };

function normalizePageSize(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_PREFERENCES.tablePageSize;
}

// Canonical stored shape uses `tablePageSize`; `pageSize` is the legacy alias the
// frontend (web/src/App.tsx) still sends/expects, mapped on the wire.
function toResponsePreferences(stored = {}) {
  const tablePageSize = normalizePageSize(stored.tablePageSize);
  return {
    theme: stored.theme === 'dark' ? 'dark' : 'light',
    sidebarCollapsed: typeof stored.sidebarCollapsed === 'boolean' ? stored.sidebarCollapsed : false,
    tablePageSize,
    pageSize: tablePageSize,
  };
}

// ReDoS-safe email validation for invite flows. Runs in pure string logic
// with no regular expression over attacker-controlled input.
function isValidInviteEmail(email) {
  if (typeof email !== 'string' || email.length === 0 || email.length > 254) return false;

  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return false;

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || domain.length === 0) return false;

  for (let i = 0; i < email.length; i++) {
    const code = email.charCodeAt(i);
    if (code <= 32 || code === 127) return false;
  }

  if (email[0] === '.' || email[email.length - 1] === '.' || email.includes('..')) return false;

  const lastDot = domain.lastIndexOf('.');
  if (lastDot < 1 || lastDot === domain.length - 1) return false;
  const tld = domain.slice(lastDot + 1);
  if (tld.length < 2) return false;
  for (let i = 0; i < tld.length; i++) {
    const code = tld.charCodeAt(i);
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (!isLetter) return false;
  }

  return true;
}

export default function registerAuthRoutes(app) {
  /**
   * GET /api/health
   * Public liveness probe for uptime checks and infrastructure.
   * Response: 200 { ok: true }
   */
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  /**
   * GET /api/auth/status
   * Public. Reports whether the workspace has been provisioned yet.
   * Response: 200 { needsSetup: boolean }
   */
  app.get('/api/auth/status', async (req, res) => {
    const db = await readDb();
    res.json({ needsSetup: db.users.length === 0 });
  });

  /**
   * POST /api/auth/setup
   * Public (rate-limited). Creates the initial Owner account and workspace on a
   * fresh install. Returns a session token.
   * Body (SetupSchema): { name: string, email: string, password: string }
   * Response: 200 { token: string, user: {...} } | 409 { error } if already configured
   */
  app.post('/api/auth/setup', authLimiter, validate(SetupSchema), async (req, res) => {
    const { name, email, password } = req.body;
    let refreshToken = null;
    const result = await mutateDb(db => {
      if (db.users.length) return null;
      db.sessions = db.sessions.filter(session => !sessionIsExpired(session));
      const user = { id: id('usr'), name: name.trim(), email: email.trim().toLowerCase(), password: hashPassword(password), role: 'Owner', workspaceId: id('ws'), createdAt: now() };
      db.users.push(user);
      db.team.push({ id: id('team'), name: user.name, email: user.email, role: 'Owner', status: 'Active', createdAt: now() });
      const pair = issueSessionPair(db, user.id);
      refreshToken = pair.refreshToken;
      db.audit.unshift({ id: id('audit'), action: 'Workspace created', actor: user.name, createdAt: now() });
      return { token: pair.accessToken, user: publicUser(user), expiresIn: pair.expiresIn };
    });
    if (!result) return res.status(409).json({ error: 'Workspace is already configured' });
    setRefreshCookie(res, refreshToken);
    res.json(result);
  });

  /**
   * POST /api/auth/login
   * Public (rate-limited). Authenticates an existing user and issues a session token.
   * Body (LoginSchema): { email: string, password: string }
   * Response: 200 { token: string, user: {...} } | 401 { error } on bad credentials
   */
  app.post('/api/auth/login', authLimiter, validate(LoginSchema), async (req, res) => {
    const { email, password } = req.body;
    const db = await readDb();
    const user = db.users.find(x => x.email === String(email || '').trim().toLowerCase());
    if (!user || !verifyPassword(String(password || ''), user.password)) return res.status(401).json({ error: 'Invalid email or password' });
    let refreshToken = null;
    const result = await mutateDb(next => {
      // Signing in on a new device no longer revokes the other devices; only
      // expired sessions are pruned. Revocation is an explicit logout-all.
      next.sessions = next.sessions.filter(x => !sessionIsExpired(x));
      const pair = issueSessionPair(next, user.id);
      refreshToken = pair.refreshToken;
      next.audit.unshift({ id: id('audit'), action: 'Signed in', actor: user.name, createdAt: now() });
      return { token: pair.accessToken, user: publicUser(user), expiresIn: pair.expiresIn };
    });
    setRefreshCookie(res, refreshToken);
    res.json({
      token: result.token,
      refreshToken,
      expiresIn: result.expiresIn,
      user: publicUser({ ...user, preferences: toResponsePreferences(db.settings?.userPreferences?.[user.id]) }),
    });
  });

  /**
   * POST /api/auth/refresh
   * Public (rate-limited by refreshLimiter). Rotates a still-valid session
   * token for a freshly minted one and revokes the presented token.
   * Token sources: body.refreshToken, body.token, x-refresh-token header, or
   * Authorization: Bearer <token>.
   * Response: 200 { token: string, user: { ... } } | 400/401 { error }
   */
  // Public endpoint: accept a team invitation emailed to the user. No auth
  // middleware here — everything is validated against the invite token.
  app.post('/api/auth/accept-invite', inviteLimiter, async (req, res) => {
    const { token, name, password } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanPassword = String(password || '');
    if (!token || !cleanName || cleanPassword.length < 6) {
      return res.status(400).json({
        error: 'token, name, and a password of at least 6 characters are required',
      });
    }

    const result = await mutateDb(db => {
      db.invites = db.invites || [];
      const invite = db.invites.find(item => item.token === token);
      if (!invite) return { error: 'Invitation is invalid or has expired' };
      if (new Date(invite.expiresAt).getTime() < Date.now()) {
        return { error: 'Invitation is invalid or has expired' };
      }
      if (db.users.find(u => u.email === invite.email)) {
        return { status: 409, error: 'Email already exists' };
      }

      const user = {
        id: id('usr'),
        name: cleanName,
        email: invite.email,
        password: hashPassword(cleanPassword),
        role: 'member',
        createdAt: now(),
      };
      db.users.push(user);
      db.team.push({
        id: id('team'),
        name: user.name,
        email: user.email,
        role: 'member',
        status: 'Active',
        createdAt: now(),
      });
      db.invites = db.invites.filter(item => item.token !== token);
      const sessionToken = crypto.randomBytes(32).toString('hex');
      db.sessions.push({
        token: sessionToken,
        userId: user.id,
        createdAt: now(),
        expiresAt: sessionExpiresAt(),
      });
      db.audit.unshift({
        id: id('audit'),
        action: 'Accepted invitation',
        actor: user.name,
        createdAt: now(),
      });
      return { token: sessionToken, user: publicUser(user) };
    });

    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json(result);
  });

  // Exchanges a still-valid refresh credential for a freshly minted access
  // token pair. `auth` is deliberately not used: it rejects expired sessions,
  // which is precisely the state a caller needs to refresh out of, so the
  // credential is validated against the store instead.
  //
  // Rotation marks the presented refresh token consumed and issues its
  // replacement in the same family. Replaying a consumed token is treated as
  // theft and revokes every session the user holds.
  //
  // Accepted credential sources, in order: the http-only refresh cookie,
  // body.refreshToken, body.token, the x-refresh-token header, and
  // Authorization: Bearer. A presented value that is not a known refresh token
  // falls back to legacy access-token rotation so older clients keep working.
  app.post('/api/auth/refresh', refreshLimiter, async (req, res) => {
    const presented = readPresentedToken(req);
    if (!presented) {
      // Distinguish a malformed JSON call (400) from a bare request that simply
      // carries no credential (401); the older client contract expects both.
      const hasJsonBody = req.headers['content-type']?.includes('application/json');
      return res.status(hasJsonBody ? 400 : 401).json({ error: 'Refresh token is required' });
    }

    const result = await mutateDb(db => {
      // A hashed refresh session rotates within its family. Anything else is a
      // legacy opaque session token (body.token, x-refresh-token, Bearer, or the
      // pre-rotation refreshToken convention) and rotates in place.
      const rotated = findRefreshSession(db, presented.value)
        ? rotateRefreshToken(db, presented.value)
        : rotateLegacyAccessToken(db, presented.value);

      if (rotated.reuseDetected) {
        db.audit.unshift({
          id: id('audit'),
          action: 'Refresh token reuse detected - all sessions revoked',
          actor: 'Security',
          createdAt: now(),
        });
      }
      return rotated;
    });

    if (result.error) {
      if (result.reuseDetected) clearRefreshCookie(res);
      return res.status(401).json({ error: result.error });
    }

    if (result.refreshToken) setRefreshCookie(res, result.refreshToken);
    // The refresh response is the same shape as legacy /login's token pair, and
    // historically never carried UI preferences; keep that contract stable.
    const responseUser = publicUser(result.user);
    delete responseUser.preferences;
    res.json({
      token: result.accessToken,
      user: responseUser,
      expiresIn: result.expiresIn,
      rotatedAt: now(),
    });
  });

  /**
   * GET /api/auth/me
   * Protected. Returns the currently authenticated user's public shape with
   * their stored UI preferences.
   * Response: 200 { user: { id, name, email, role, preferences } } | 401 { error }
   */
  app.get('/api/auth/me', auth, async (req, res) => {
    const db = await readDb();
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ user: publicUser({ ...user, preferences: toResponsePreferences(db.settings?.userPreferences?.[user.id]) }) });
  });

  /**
   * GET /api/users/me/preferences
   * Protected. Returns the current user's UI preferences.
   * Response: 200 { preferences: { theme, sidebarCollapsed, pageSize } } | 404 { error }
   */
  app.get('/api/users/me/preferences', auth, async (req, res) => {
    const db = await readDb();
    const user = db.users.find(u => u.id === req.user.id);

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      preferences: toResponsePreferences(db.settings?.userPreferences?.[req.user.id]),
    });
  });

  /**
   * PUT /api/users/me/preferences
   * Protected. Merges the current user's UI preferences.
   * Body: { theme?: 'light'|'dark', sidebarCollapsed?: boolean, pageSize?: number }
   * Response: 200 { preferences: {...} } | 404 { error }
   */
  app.put('/api/users/me/preferences', auth, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { theme, sidebarCollapsed } = body;
    const pageSize = body.tablePageSize ?? body.pageSize;

    if (theme !== undefined && theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    if (sidebarCollapsed !== undefined && typeof sidebarCollapsed !== 'boolean') {
      return res.status(400).json({ error: 'sidebarCollapsed must be a boolean' });
    }
    if (pageSize !== undefined && (typeof pageSize !== 'number' || !Number.isFinite(pageSize) || pageSize <= 0)) {
      return res.status(400).json({ error: 'page size must be a positive number' });
    }

    const result = await mutateDb(db => {
      const user = db.users.find(u => u.id === req.user.id);
      if (!user) return null;

      db.settings = db.settings || {};
      db.settings.userPreferences = db.settings.userPreferences || {};
      const next = { ...(db.settings.userPreferences[req.user.id] || {}) };
      if (theme === 'light' || theme === 'dark') next.theme = theme;
      if (typeof sidebarCollapsed === 'boolean') next.sidebarCollapsed = sidebarCollapsed;
      if (typeof pageSize === 'number' && Number.isFinite(pageSize) && pageSize > 0) next.tablePageSize = pageSize;
      db.settings.userPreferences[req.user.id] = next;

      return next;
    });

    if (!result) return res.status(404).json({ error: 'User not found' });

    res.json({ preferences: toResponsePreferences(result) });
  });

  /**
   * POST /api/auth/events-token
   * Protected. Issues a short-lived session token used to authenticate the SSE
   * event stream.
   * Response: 200 { token: string, expiresAt: ISO string }
   */
  app.post('/api/auth/events-token', auth, async (req, res) => {
    const sseLifetimeMs = 120_000;
    const token = crypto.randomBytes(32).toString('hex');
    await mutateDb(db => {
      db.sessions.push({
        token,
        userId: req.user.id,
        createdAt: now(),
        expiresAt: new Date(Date.now() + sseLifetimeMs).toISOString(),
        purpose: 'sse',
      });
    });
    res.json({ token, expiresAt: new Date(Date.now() + sseLifetimeMs).toISOString() });
  });

  /**
   * POST /api/auth/logout
   * Protected. Invalidates the current session token.
   * Response: 200 { ok: true }
   */
  app.post('/api/auth/logout', auth, async (req, res) => {
    const presented = readPresentedToken(req);
    await mutateDb(db => {
      db.sessions = db.sessions.filter(x => x.token !== req.token);
      // The browser sends the refresh cookie here, so revoke the whole family
      // too - otherwise the cookie would mint a fresh access token. Other
      // devices keep their own families and access tokens.
      if (presented) {
        const family = findRefreshSession(db, presented.value);
        if (family) revokeRefreshFamily(db, family);
      }
    });
    clearRefreshCookie(res);
    res.json({ ok: true });
  });

  /**
   * POST /api/auth/logout-all
   * Protected. Invalidates every session belonging to the current user.
   * Response: 200 { ok: true }
   */
  app.post('/api/auth/logout-all', auth, async (req, res) => {
    const result = await mutateDb(db => {
      const revoked = revokeAllUserSessions(db, req.user.id);
      db.audit.unshift({
        id: id('audit'),
        action: `Revoked all sessions for ${req.user.name}`,
        actor: req.user.name,
        createdAt: now(),
      });
      return revoked;
    });
    clearRefreshCookie(res);
    res.json({
      ok: true,
      revokedSessions: result.total,
      revokedRefreshTokens: result.refresh,
    });
  });

  /**
   * GET /api/users
   * Protected. Lists all workspace users in public shape.
   * Response: 200 [{ id, name, email, role, preferences }]
   */
  app.get('/api/users', auth, async (req, res) => {
    const db = await readDb();
    res.json(paginateAndSort(db.users.map(u => publicUser(u)), req.query));
  });

  /**
   * PATCH /api/users/:id/role
   * Admin-only. Changes a user's role (admin | member | viewer).
   * Path param: :id - user id
   * Body: { role: 'admin'|'member'|'viewer' }
   * Response: 200 { user public shape } | 400/404 { error }
   */
  app.patch('/api/users/:id/role', auth, requireAdmin, async (req, res) => {
    const { role } = req.body;
    if (!['admin', 'member', 'viewer'].includes(role)) return res.status(400).json({ error: 'Role must be admin, member, or viewer' });
    const saved = await mutateDb(db => {
      const user = db.users.find(u => u.id === req.params.id);
      if (!user) return null;
      user.role = role;
      user.updatedAt = now();
      db.audit.unshift({ id: id('audit'), action: `Changed role of ${user.name} to ${role}`, actor: req.user.name, createdAt: now() });
      return publicUser(user);
    });
    if (!saved) return res.status(404).json({ error: 'User not found' });
    broadcast('user.role.changed', { userId: saved.id, role: saved.role }, req.user.workspaceId || 'default');
    res.json(saved);
  });

  /**
   * POST /api/users
   * Admin-only. Creates a new member user and team entry directly.
   * Body (SetupSchema): { name: string, email: string, password: string }
   * Response: 201 { user public shape } | 409 { error } if email exists
   */
  app.post('/api/users', auth, requireAdmin, validate(SetupSchema), async (req, res) => {
    const { name, email, password } = req.body;
    const saved = await mutateDb(db => {
      if (db.users.find(u => u.email === email.toLowerCase())) return null;
      const user = { id: id('usr'), name: name.trim(), email: email.trim().toLowerCase(), password: hashPassword(password), role: 'member', createdAt: now() };
      db.users.push(user);
      db.team.push({ id: id('team'), name: user.name, email: user.email, role: 'member', status: 'Active', createdAt: now() });
      db.audit.unshift({ id: id('audit'), action: `Invited user: ${user.email}`, actor: req.user.name, createdAt: now() });
      return publicUser(user);
    });
    if (!saved) return res.status(409).json({ error: 'Email already exists' });
    broadcast('user.created', { user: saved }, req.user.workspaceId || 'default');
    res.status(201).json(saved);
  });

  /**
   * DELETE /api/users/:id
   * Admin-only. Removes a user, their team entry and all their sessions.
   * Path param: :id - user id (cannot be the caller's own id).
   * Response: 200 { ok: true } | 400/404 { error }
   */
  // Admin-only: generate a secure, emailed invitation instead of creating the
  // user account directly. The accept link embeds a one-time token.
  app.post('/api/users/invite', auth, requireAdmin, async (req, res) => {
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();
    if (!isValidInviteEmail(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const invite = await mutateDb(db => {
      if (db.users.find(u => u.email === email)) return null;
      db.invites = db.invites || [];
      // Re-inviting an email invalidates any previously pending invite.
      db.invites = db.invites.filter(entry => entry.email !== email);
      const entry = {
        id: id('inv'),
        email,
        token: crypto.randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        createdAt: now(),
        createdBy: req.user.id,
      };
      db.invites.push(entry);
      return entry;
    });
    if (!invite) return res.status(409).json({ error: 'Email already exists' });

    const settings = await getSettings();
    const link = `${settings.publicBaseUrl || ''}/accept-invite?token=${invite.token}`;
    await sendEmail(settings, {
      to: email,
      subject: 'You are invited to join the Tunaxa workspace',
      text: `Click the link below to accept your invitation:\n\n${link}`,
      html: `<p>Click the link below to accept your invitation:</p><p><a href="${link}">${link}</a></p>`,
    });
    res.status(201).json({ ok: true, id: invite.id, email: invite.email, expiresAt: invite.expiresAt });
  });

  app.delete('/api/users/:id', auth, requireAdmin, async (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    let deleted = null;
    await mutateDb(db => {
      const index = db.users.findIndex(u => u.id === req.params.id);
      if (index < 0) return;
      deleted = publicUser(db.users[index]);
      db.users.splice(index, 1);
      db.team = db.team.filter(t => t.email !== deleted.email);
      db.sessions = db.sessions.filter(s => s.userId !== deleted.id);
      db.audit.unshift({ id: id('audit'), action: `Removed user: ${deleted.email}`, actor: req.user.name, createdAt: now() });
    });
    if (!deleted) return res.status(404).json({ error: 'User not found' });
    broadcast('user.deleted', { userId: deleted.id }, req.user.workspaceId || 'default');
    res.json({ ok: true });
  });
}
