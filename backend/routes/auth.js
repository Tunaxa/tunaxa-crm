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

export default function registerAuthRoutes(app) {
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/auth/status', async (req, res) => {
    const db = await readDb();
    res.json({ needsSetup: db.users.length === 0 });
  });

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
    res.json({ token, user: publicUser(user) });
  });

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
      return res.status(400).json({ error: 'Refresh token is required' });
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
        return { token: nextToken, user: publicUser(user) };
      });

      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

  app.post('/api/auth/logout', auth, async (req, res) => {
    await mutateDb(db => { db.sessions = db.sessions.filter(x => x.token !== req.token); });
    res.json({ ok: true });
  });

  app.post('/api/auth/logout-all', auth, async (req, res) => {
    await mutateDb(db => { db.sessions = db.sessions.filter(x => x.userId !== req.user.id); });
    res.json({ ok: true });
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
    broadcast('user.role.changed', { userId: saved.id, role: saved.role });
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
    broadcast('user.created', { user: saved });
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
    broadcast('user.deleted', { userId: deleted.id });
    res.json({ ok: true });
  });
}
