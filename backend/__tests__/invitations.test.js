import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { closePool } from '../db/pg.js';
import { readDb, mutateDb } from '../store.js';
import { hashPassword } from '../helpers.js';
import { resetTestDb, seedTestUser, loginAs } from './setup.js';

// Team invitations & role assignment (P2-BE1-05). These tests pin the lifecycle
// (create -> list -> resend -> revoke -> accept), the token secret handling
// (only a hash is stored, lists never echo a token) and the authorization
// boundary (only admins manage invites; any authenticated user may list).

let app;
let adminToken;
let memberToken;

const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

const createInvite = (payload, token = adminToken) =>
  request(app).post('/api/team/invites').set(auth(token)).send(payload);

const listInvites = (token = adminToken) =>
  request(app).get('/api/team/invites').set(auth(token));

const resendInvite = (id, token = adminToken) =>
  request(app).post(`/api/team/invites/${id}/resend`).set(auth(token)).send({});

const revokeInvite = (id, token = adminToken) =>
  request(app).post(`/api/team/invites/${id}/revoke`).set(auth(token)).send({});

const acceptInvite = (payload, path = '/api/invitations/accept') =>
  request(app).post(path).send(payload);

const validateToken = (token) => request(app).get(`/api/invitations/${token}`);

const tokenFromJoinUrl = (url) => {
  const match = String(url || '').match(/token=([a-f0-9]{64})/i);
  return match ? match[1] : null;
};

const storedInvite = async (email) => {
  const db = await readDb();
  return (db.invitations || []).find((invite) => invite.email === email) || null;
};

const latestEmail = async (email) => {
  const db = await readDb();
  return (db.emailOutbox || []).find((mail) => mail.to === email) || null;
};

function expireInvite(email) {
  return mutateDb((db) => {
    const invite = (db.invitations || []).find((item) => item.email === email);
    if (invite) invite.expiresAt = new Date(Date.now() - 1000).toISOString();
  });
}

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  adminToken = await loginAs(app);

  // A non-admin session for the authorization tests. Seeded directly so the
  // login rate limiter is never in play.
  await mutateDb((db) => {
    db.users.push({
      id: 'usr_member',
      name: 'Member User',
      email: 'member@test.com',
      password: hashPassword('test123'),
      role: 'member',
      createdAt: new Date().toISOString(),
    });
    db.sessions.push({
      token: 'member-session-token',
      userId: 'usr_member',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  });
  memberToken = 'member-session-token';
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  // Each test starts from an empty invite list and outbox; users/sessions seeded
  // once in beforeAll persist, so tests use unique addresses.
  await mutateDb((db) => {
    db.invitations = [];
    db.emailOutbox = [];
  });
});

describe('authentication & authorization', () => {
  it('requires authentication to create or list invitations', async () => {
    const create = await request(app).post('/api/team/invites').send({ email: 'x@example.com' });
    expect(create.status).toBe(401);

    const list = await request(app).get('/api/team/invites');
    expect(list.status).toBe(401);
  });

  it('restricts management to admins while letting members list', async () => {
    const denied = await createInvite({ email: 'blocked@example.com' }, memberToken);
    expect(denied.status).toBe(403);

    const list = await listInvites(memberToken);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.invites)).toBe(true);

    const created = await createInvite({ email: 'protected@example.com' });
    const id = created.body.invite.id;
    expect((await resendInvite(id, memberToken)).status).toBe(403);
    expect((await revokeInvite(id, memberToken)).status).toBe(403);
    expect((await request(app).delete(`/api/team/invites/${id}`).set(auth(memberToken))).status).toBe(403);
  });
});

describe('POST /api/team/invites', () => {
  it('creates a pending invite, stores only a token hash and dispatches an email', async () => {
    const res = await createInvite({ email: 'new.member@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.invite).toMatchObject({
      email: 'new.member@example.com',
      role: 'member',
      status: 'pending',
    });

    const token = tokenFromJoinUrl(res.body.joinUrl);
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    const stored = await storedInvite('new.member@example.com');
    expect(stored.tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(stored.token).toBeUndefined();
    expect(stored.status).toBe('pending');

    const mail = await latestEmail('new.member@example.com');
    expect(mail).toBeTruthy();
    expect(mail.subject).toMatch(/invited you to join/i);
    expect(mail.text).toContain(token);
    expect(typeof mail.status).toBe('string');
    expect(mail.delivered).toBe(false);
  });

  it('normalizes the email to lowercase and honors an explicit role', async () => {
    const res = await createInvite({ email: 'MiXeD.Case@Example.COM', role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.invite.email).toBe('mixed.case@example.com');
    expect(res.body.invite.role).toBe('admin');
    expect((await storedInvite('mixed.case@example.com')).email).toBe('mixed.case@example.com');
  });

  it('rejects a malformed email and an unknown role', async () => {
    expect((await createInvite({ email: 'not-an-email' })).status).toBe(400);
    expect((await createInvite({ email: 'role@example.com', role: 'wizard' })).status).toBe(400);
  });

  it('cannot invite an email that already belongs to a user', async () => {
    const res = await createInvite({ email: 'test@test.com' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('refreshes an existing pending invite instead of duplicating it', async () => {
    const first = await createInvite({ email: 'dupe@example.com', role: 'viewer' });
    const tokenOne = tokenFromJoinUrl(first.body.joinUrl);

    const second = await createInvite({ email: 'dupe@example.com', role: 'viewer' });
    expect(second.status).toBe(200);
    expect(second.body.invite.id).toBe(first.body.invite.id);

    const tokenTwo = tokenFromJoinUrl(second.body.joinUrl);
    expect(tokenTwo).not.toBe(tokenOne);
    expect((await validateToken(tokenOne)).status).toBe(404);
    expect((await validateToken(tokenTwo)).status).toBe(200);

    const db = await readDb();
    expect(db.invitations.filter((invite) => invite.email === 'dupe@example.com')).toHaveLength(1);
  });
});

describe('GET /api/team/invites', () => {
  it('lists invitations without exposing the secret token', async () => {
    const created = await createInvite({ email: 'listed@example.com', role: 'admin' });
    const token = tokenFromJoinUrl(created.body.joinUrl);

    const res = await listInvites();
    expect(res.status).toBe(200);

    const item = res.body.invites.find((invite) => invite.email === 'listed@example.com');
    expect(item).toMatchObject({ email: 'listed@example.com', role: 'admin', status: 'pending' });
    expect(item).not.toHaveProperty('token');
    expect(item).not.toHaveProperty('tokenHash');

    const payload = JSON.stringify(res.body);
    expect(payload).not.toContain('tokenHash');
    expect(payload).not.toContain(token);
  });
});

describe('frontend compatibility aliases', () => {
  it('serves /api/users/invite and /api/users/invites with the same contract and guard', async () => {
    const create = await request(app)
      .post('/api/users/invite')
      .set(auth())
      .send({ email: 'legacy@example.com' });
    expect(create.status).toBe(201);
    expect(create.body.invite.email).toBe('legacy@example.com');

    const list = await request(app).get('/api/users/invites').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.invites.some((invite) => invite.email === 'legacy@example.com')).toBe(true);

    const denied = await request(app)
      .post('/api/users/invite')
      .set(auth(memberToken))
      .send({ email: 'legacy-denied@example.com' });
    expect(denied.status).toBe(403);
  });
});

describe('POST /api/team/invites/:id/resend', () => {
  it('issues a fresh token, extends expiry and invalidates the old link', async () => {
    const created = await createInvite({ email: 'resend@example.com' });
    const id = created.body.invite.id;
    const tokenOne = tokenFromJoinUrl(created.body.joinUrl);
    const expiryOne = Date.parse(created.body.invite.expiresAt);

    const res = await resendInvite(id);
    expect(res.status).toBe(200);
    const tokenTwo = tokenFromJoinUrl(res.body.joinUrl);
    expect(tokenTwo).not.toBe(tokenOne);
    expect(Date.parse(res.body.invite.expiresAt)).toBeGreaterThanOrEqual(expiryOne);
    expect(res.body.invite.resendCount).toBe(1);

    expect((await validateToken(tokenOne)).status).toBe(404);
    expect((await validateToken(tokenTwo)).status).toBe(200);

    const mail = await latestEmail('resend@example.com');
    expect(mail.text).toContain(tokenTwo);
  });

  it('returns 404 for an unknown id and 400 for a revoked invite', async () => {
    expect((await resendInvite('inv_missing')).status).toBe(404);

    const created = await createInvite({ email: 'resend-revoked@example.com' });
    const id = created.body.invite.id;
    await revokeInvite(id);
    const res = await resendInvite(id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/revoked/i);
  });
});

describe('revoke', () => {
  it('marks an invite revoked and blocks acceptance', async () => {
    const created = await createInvite({ email: 'revoke@example.com' });
    const id = created.body.invite.id;
    const token = tokenFromJoinUrl(created.body.joinUrl);

    const res = await revokeInvite(id);
    expect(res.status).toBe(200);
    expect(res.body.invite.status).toBe('revoked');

    expect((await validateToken(token)).status).toBe(404);
    const accept = await acceptInvite({ token, name: 'Revoked User', password: 'secret123' });
    expect(accept.status).toBe(404);

    const stored = await storedInvite('revoke@example.com');
    expect(stored.status).toBe('revoked');
    expect(stored.revokedAt).toBeTruthy();
  });

  it('supports DELETE as a revoke alias and 404s an unknown id', async () => {
    const created = await createInvite({ email: 'delete@example.com' });
    const id = created.body.invite.id;

    const res = await request(app).delete(`/api/team/invites/${id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.invite.status).toBe('revoked');

    expect((await request(app).delete('/api/team/invites/inv_missing').set(auth())).status).toBe(404);
  });
});

describe('GET /api/invitations/:token', () => {
  it('validates a pending token without consuming it', async () => {
    const created = await createInvite({ email: 'validate@example.com' });
    const token = tokenFromJoinUrl(created.body.joinUrl);

    const first = await validateToken(token);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      valid: true,
      expired: false,
      status: 'pending',
      email: 'validate@example.com',
      role: 'member',
    });

    const second = await validateToken(token);
    expect(second.status).toBe(200);
    expect(second.body.valid).toBe(true);

    const stored = await storedInvite('validate@example.com');
    expect(stored.status).toBe('pending');
  });

  it('reports an expired token and rejects unknown or malformed tokens', async () => {
    const created = await createInvite({ email: 'expired@example.com' });
    const token = tokenFromJoinUrl(created.body.joinUrl);
    await expireInvite('expired@example.com');

    const res = await validateToken(token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: false, expired: true, status: 'expired' });

    expect((await validateToken('a'.repeat(64))).status).toBe(404);
    expect((await validateToken('not-a-token')).status).toBe(404);
  });
});

describe('POST /api/invitations/accept', () => {
  it('creates the user with the designated role and authenticates them', async () => {
    const created = await createInvite({ email: 'accept.admin@example.com', role: 'admin' });
    const token = tokenFromJoinUrl(created.body.joinUrl);

    const res = await acceptInvite({ token, name: 'New Admin', password: 'secret123' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'accept.admin@example.com', role: 'admin', name: 'New Admin' });
    expect(typeof res.body.token).toBe('string');

    const me = await request(app).get('/api/auth/me').set(auth(res.body.token));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('accept.admin@example.com');

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'accept.admin@example.com', password: 'secret123' });
    expect(login.status).toBe(200);

    const stored = await storedInvite('accept.admin@example.com');
    expect(stored.status).toBe('accepted');
    expect(stored.acceptedAt).toBeTruthy();
    expect(stored.acceptedBy).toBe(res.body.user.id);
  });

  it('works through the /api/auth/accept-invite alias', async () => {
    const created = await createInvite({ email: 'alias@example.com' });
    const token = tokenFromJoinUrl(created.body.joinUrl);

    const res = await acceptInvite(
      { token, name: 'Alias User', password: 'secret123' },
      '/api/auth/accept-invite',
    );
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('alias@example.com');
  });

  it('rejects an expired invitation', async () => {
    const created = await createInvite({ email: 'expired.accept@example.com' });
    const token = tokenFromJoinUrl(created.body.joinUrl);
    await expireInvite('expired.accept@example.com');

    const res = await acceptInvite({ token, name: 'Late User', password: 'secret123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('rejects a revoked or already-accepted token', async () => {
    const revoked = await createInvite({ email: 'revoked.accept@example.com' });
    const revokedToken = tokenFromJoinUrl(revoked.body.joinUrl);
    await revokeInvite(revoked.body.invite.id);
    expect((await acceptInvite({ token: revokedToken, name: 'Gone', password: 'secret123' })).status).toBe(404);

    const accepted = await createInvite({ email: 'twice@example.com' });
    const acceptedToken = tokenFromJoinUrl(accepted.body.joinUrl);
    expect((await acceptInvite({ token: acceptedToken, name: 'First', password: 'secret123' })).status).toBe(201);
    expect((await acceptInvite({ token: acceptedToken, name: 'Second', password: 'secret123' })).status).toBe(404);
  });

  it('rejects tampered tokens and enforces the password policy', async () => {
    expect((await acceptInvite({ token: 'not-a-token', name: 'X', password: 'secret123' })).status).toBe(404);
    expect((await acceptInvite({ token: 'a'.repeat(64), name: 'X', password: 'secret123' })).status).toBe(404);

    const created = await createInvite({ email: 'weak@example.com' });
    const token = tokenFromJoinUrl(created.body.joinUrl);
    expect((await acceptInvite({ token, name: 'Weak', password: '123' })).status).toBe(400);
  });
});
