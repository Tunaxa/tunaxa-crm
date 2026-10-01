import crypto from 'node:crypto';
import { readDb, mutateDb } from '../store.js';
import { auth, sessionIsExpired } from '../middleware/auth.js';
import { hashPassword, verifyPassword, publicUser, now, id } from '../helpers.js';
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

const authLimiter = createRateLimiter({ windowMs: 60_000, max: 10, prefix: 'auth' });
// Silent renewal is routine traffic (many tabs, several devices), so it gets its
// own bucket instead of competing with credential-guessing limits on login.
const refreshLimiter = createRateLimiter({ windowMs: 60_000, max: 30, prefix: 'auth-refresh' });

export default function registerAuthRoutes(app) {
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/auth/status', async (req, res) => {
    const db = await readDb();
    res.json({ needsSetup: db.users.length === 0 });
  });

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
    res.json(result);
  });

  app.post('/api/auth/refresh', refreshLimiter, async (req, res) => {
    const presented = readPresentedToken(req);
    if (!presented) return res.status(401).json({ error: 'Unauthorized' });

    const result = await mutateDb(db => {
      const rotated = presented.source === 'bearer' && !findRefreshSession(db, presented.value)
        ? rotateLegacyAccessToken(db, presented.value)
        : rotateRefreshToken(db, presented.value);

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

    setRefreshCookie(res, result.refreshToken);
    res.json({
      token: result.accessToken,
      user: publicUser(result.user),
      expiresIn: result.expiresIn,
      rotatedAt: now(),
    });
  });

  app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
    app.get('/api/users/me/preferences', auth, async (req, res) => {
    const db = await readDb();
    const user = db.users.find(u => u.id === req.user.id);

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      preferences: user.preferences || {
        theme: 'light',
        sidebarCollapsed: false,
        pageSize: 25,
      },
    });
  });

  app.put('/api/users/me/preferences', auth, async (req, res) => {
    const { theme, sidebarCollapsed, pageSize } = req.body;

    const result = await mutateDb(db => {
      const user = db.users.find(u => u.id === req.user.id);
      if (!user) return null;

      user.preferences = {
        ...(user.preferences || {}),
        ...(theme === 'light' || theme === 'dark' ? { theme } : {}),
        ...(typeof sidebarCollapsed === 'boolean' ? { sidebarCollapsed } : {}),
        ...(Number.isInteger(pageSize) && pageSize > 0 ? { pageSize } : {}),
      };

      return user.preferences;
    });

    if (!result) return res.status(404).json({ error: 'User not found' });

    res.json({ preferences: result });
  });

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

  app.post('/api/auth/logout', auth, async (req, res) => {
    const presented = readPresentedToken(req);
    await mutateDb(db => {
      db.sessions = db.sessions.filter(x => x.token !== req.token);
      // The browser always sends the refresh cookie here, so revoke the whole
      // family too - otherwise the cookie would mint a fresh access token.
      // Other devices keep their own families and access tokens.
      if (presented && presented.source !== 'bearer') {
        const family = findRefreshSession(db, presented.value);
        if (family) revokeRefreshFamily(db, family);
      }
    });
    clearRefreshCookie(res);
    res.json({ ok: true });
  });

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

  app.get('/api/users', auth, async (req, res) => {
    const db = await readDb();
    res.json(db.users.map(u => publicUser(u)));
  });

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
