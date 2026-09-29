import crypto from 'node:crypto';
import { readDb, mutateDb } from '../store.js';
import { auth, sessionExpiresAt, sessionIsExpired } from '../middleware/auth.js';
import { hashPassword, verifyPassword, publicUser, now, id } from '../helpers.js';
import { validate, SetupSchema, LoginSchema } from '../services/validate.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { requireAdmin } from '../middleware/rbac.js';
import { broadcast } from './sse.js';

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
    const result = await mutateDb(db => {
      if (db.users.length) return null;
      db.sessions = db.sessions.filter(session => !sessionIsExpired(session));
      const user = { id: id('usr'), name: name.trim(), email: email.trim().toLowerCase(), password: hashPassword(password), role: 'Owner', workspaceId: id('ws'), createdAt: now() };
      const token = crypto.randomBytes(32).toString('hex');
      db.users.push(user);
      db.team.push({ id: id('team'), name: user.name, email: user.email, role: 'Owner', status: 'Active', createdAt: now() });
      db.sessions.push({ token, userId: user.id, createdAt: now(), expiresAt: sessionExpiresAt() });
      db.audit.unshift({ id: id('audit'), action: 'Workspace created', actor: user.name, createdAt: now() });
      return { token, user: publicUser(user) };
    });
    if (!result) return res.status(409).json({ error: 'Workspace is already configured' });
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
    const token = crypto.randomBytes(32).toString('hex');
    await mutateDb(next => {
      next.sessions = next.sessions.filter(x => x.userId !== user.id && !sessionIsExpired(x));
      next.sessions.push({ token, userId: user.id, createdAt: now(), expiresAt: sessionExpiresAt() });
      next.audit.unshift({ id: id('audit'), action: 'Signed in', actor: user.name, createdAt: now() });
    });
    res.json({ token, user: publicUser({ ...user, preferences: toResponsePreferences(db.settings?.userPreferences?.[user.id]) }) });
  });

  /**
   * POST /api/auth/refresh
   * Public (rate-limited by refreshLimiter). Rotates a still-valid session
   * token for a freshly minted one and revokes the presented token.
   * Token sources: body.refreshToken, body.token, x-refresh-token header, or
   * Authorization: Bearer <token>.
   * Response: 200 { token: string, user: { ... } } | 400/401 { error }
   */
  // Exchanges a still-valid session token for a freshly minted one.
  //
  // This is session rotation, not a JWT refresh. Tokens in this app are opaque
  // 32-byte random strings recorded in db.sessions and validated by lookup in
  // middleware/auth.js -- there is no signature and no JWT_SECRET -- so
  // "refreshing" means resolving the caller's session record and rotating it.
  //
  // `auth` is deliberately not used here: it rejects expired sessions, which is
  // precisely the state a caller needs to refresh out of. The presented token is
  // therefore validated against the store instead.
  //
  // Rotation also revokes the presented token, so a captured token stops working
  // as soon as the legitimate client refreshes once.
  //
  // No cookie lookup: there is no cookie parser in this app, so req.cookies is
  // always undefined. Supporting it would mean adding a dependency for a code
  // path nothing else uses.
  app.post('/api/auth/refresh', refreshLimiter, async (req, res, next) => {
    const token = req.body?.refreshToken
      || req.body?.token
      || req.headers['x-refresh-token']
      || req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (typeof token !== 'string' || !token.trim()) {
      const hasJsonBody = req.headers['content-type']?.includes('application/json');
      return res.status(hasJsonBody ? 400 : 401).json({ error: 'Refresh token is required' });
    }

    try {
      const result = await mutateDb(db => {
        const session = db.sessions.find(x => x.token === token);
        if (!session) return { error: 'Invalid refresh token', status: 401 };
        if (sessionIsExpired(session)) {
          // Drop the dead record so it cannot be retried indefinitely.
          db.sessions = db.sessions.filter(x => x.token !== token);
          return { error: 'Refresh token has expired', status: 401 };
        }
        // The user model carries no status/active flag, so existence is the only
        // check available. A deleted user's sessions are already cascaded away by
        // DELETE /api/users/:id, so this also covers the "user removed" case.
        const user = db.users.find(x => x.id === session.userId);
        if (!user) {
          db.sessions = db.sessions.filter(x => x.token !== token);
          return { error: 'User not found', status: 401 };
        }

        const nextToken = crypto.randomBytes(32).toString('hex');
        db.sessions = db.sessions.filter(x => x.token !== token);
        db.sessions.push({ token: nextToken, userId: user.id, createdAt: now(), expiresAt: sessionExpiresAt() });
        db.audit.unshift({ id: id('audit'), action: 'Session refreshed', actor: user.name, createdAt: now() });
        const responseUser = publicUser(user);
        delete responseUser.preferences;
        return { token: nextToken, user: responseUser };
      });

      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json(result);
    } catch (error) {
      next(error);
    }
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
    await mutateDb(db => { db.sessions = db.sessions.filter(x => x.token !== req.token); });
    res.json({ ok: true });
  });

  /**
   * POST /api/auth/logout-all
   * Protected. Invalidates every session belonging to the current user.
   * Response: 200 { ok: true }
   */
  app.post('/api/auth/logout-all', auth, async (req, res) => {
    await mutateDb(db => { db.sessions = db.sessions.filter(x => x.userId !== req.user.id); });
    res.json({ ok: true });
  });

  /**
   * GET /api/users
   * Protected. Lists all workspace users in public shape.
   * Response: 200 [{ id, name, email, role, preferences }]
   */
  app.get('/api/users', auth, async (req, res) => {
    const db = await readDb();
    res.json(db.users.map(u => publicUser(u)));
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
