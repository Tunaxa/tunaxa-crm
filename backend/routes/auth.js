import crypto from 'node:crypto';
import { readDb, mutateDb } from '../store.js';
import { auth, sessionExpiresAt, sessionIsExpired } from '../middleware/auth.js';
import { hashPassword, verifyPassword, publicUser, now, id } from '../helpers.js';
import { validate, SetupSchema, LoginSchema } from '../services/validate.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { requireAdmin } from '../middleware/rbac.js';
import { broadcast } from './sse.js';
import { getSettings } from '../services/config.js';
import { sendEmail } from '../services/smtp.js';

const authLimiter = createRateLimiter({ windowMs: 60_000, max: 10, prefix: 'auth' });

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

  // Public endpoint: accept a team invitation emailed to the user. No auth
  // middleware here — everything is validated against the invite token.
  app.post('/api/auth/accept-invite', async (req, res) => {
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

  app.post('/api/auth/refresh', authLimiter, async (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const result = await mutateDb(db => {
      const session = db.sessions.find(x => x.token === token);
      if (!session || sessionIsExpired(session)) return { error: 'Session expired' };
      const user = db.users.find(x => x.id === session.userId);
      if (!user) return { error: 'User not found' };

      const nextToken = crypto.randomBytes(32).toString('hex');
      db.sessions = db.sessions.filter(x => x.token !== token);
      db.sessions.push({ token: nextToken, userId: user.id, createdAt: now(), expiresAt: sessionExpiresAt() });
      return { token: nextToken };
    });
    if (result.error) return res.status(401).json({ error: result.error });
    res.json(result);
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

  // Admin-only: generate a secure, emailed invitation instead of creating the
  // user account directly. The accept link embeds a one-time token.
  app.post('/api/users/invite', auth, requireAdmin, async (req, res) => {
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
