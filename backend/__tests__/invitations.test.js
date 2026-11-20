import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { closePool } from '../db/pg.js';
import { readDb, mutateDb } from '../store.js';
import { hashPassword } from '../helpers.js';
import { resetTestDb, seedTestUser, loginAs } from './setup.js';

let app;
let adminToken;
let memberToken;
let viewerToken;

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

const storedInvite = async (predicate) => {
  const db = await readDb();
  const invites = db.invitations || [];
  if (typeof predicate === 'string') return invites.find((i) => i.email === predicate) || null;
  return invites.find(predicate) || null;
};

const seedSessionUser = async ({ id, name, email, role, token, workspaceId }) => {
  await mutateDb((db) => {
    db.users.push({
      id,
      name,
      email,
      password: hashPassword('test123'),
      role,
      workspaceId,
      createdAt: new Date().toISOString(),
    });
    db.sessions.push({
      token,
      userId: id,
      purpose: 'access',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  });
};

function expireInviteByEmail(email) {
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

  await seedSessionUser({
    id: 'usr_member',
    name: 'Member User',
    email: 'member@test.com',
    role: 'member',
    token: 'member-session-token',
    workspaceId: 'ws_member',
  });
  memberToken = 'member-session-token';

  await seedSessionUser({
    id: 'usr_viewer',
    name: 'Viewer User',
    email: 'viewer@test.com',
    role: 'viewer',
    token: 'viewer-session-token',
    workspaceId: 'ws_viewer',
  });
  viewerToken = 'viewer-session-token';
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await mutateDb((db) => {
    db.invitations = [];
    db.emailOutbox = [];
  });
});

describe('authentication & authorization', () => {
  it('requires authentication to create, list, resend, and revoke invitations', async () => {
    expect((await request(app).post('/api/team/invites').send({ email: 'x@example.com' })).status).toBe(401);
    expect((await request(app).get('/api/team/invites')).status).toBe(401);

    const created = await createInvite({ email: 'authz@example.com' });
    const id = created.body.invite.id;
    expect((await request(app).post(`/api/team/invites/${id}/resend`).send({})).status).toBe(401);
    expect((await request(app).post(`/api/team/invites/${id}/revoke`).send({})).status).toBe(401);
    expect((await request(app).delete(`/api/team/invites/${id}`)).status).toBe(401);
  });

  it('rejects non-admin (member/viewer) with 403 on create, list, resend, and revoke', async () => {
    for (const token of [memberToken, viewerToken]) {
      expect((await createInvite({ email: `blocked-${token}@example.com` }, token)).status).toBe(403);
      expect((await listInvites(token)).status).toBe(403);
    }

    const created = await createInvite({ email: 'protected@example.com' });
    const id = created.body.invite.id;
    for (const token of [memberToken, viewerToken]) {
      expect((await resendInvite(id, token)).status).toBe(403);
      expect((await revokeInvite(id, token)).status).toBe(403);
      expect((await request(app).delete(`/api/team/invites/${id}`).set(auth(token))).status).toBe(403);
    }
  });
});

describe('cryptographic token properties', () => {
  it('returns raw token only on create/resend, stores only a hash, and never exposes secrets in list/validate', async () => {
    const created = await createInvite({ email: 'secret@example.com' });
    expect(created.status).toBe(201);
    const token = tokenFromJoinUrl(created.body.joinUrl);
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    const stored = await storedInvite('secret@example.com');
    expect(stored).toBeTruthy();
    expect(stored.token).toBeUndefined();
    expect(stored.tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));

    const list = await listInvites();
    expect(list.status).toBe(200);
    const listed = list.body.invites.find((i) => i.email === 'secret@example.com');
    expect(listed).toBeTruthy();
    expect(listed).not.toHaveProperty('token');
    expect(listed).not.toHaveProperty('tokenHash');
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(JSON.stringify(list.body)).not.toContain('tokenHash');

    const validate = await validateToken(token);
    expect(validate.status).toBe(200);
    expect(validate.body).not.toHaveProperty('token');
    expect(validate.body).not.toHaveProperty('tokenHash');
    expect(JSON.stringify(validate.body)).not.toContain(token);

    const resent = await resendInvite(created.body.invite.id);
    expect(resent.status).toBe(200);
    const rotated = tokenFromJoinUrl(resent.body.joinUrl);
    expect(rotated).toMatch(/^[a-f0-9]{64}$/);
    expect(rotated).not.toBe(token);
    expect(resent.body.invite).not.toHaveProperty('token');
    expect(resent.body.invite).not.toHaveProperty('tokenHash');
  });
});

describe('cross-tenant isolation', () => {
  it('Tenant B admin sees 0 Tenant A invites and gets 404 when resending or revoking Tenant A invite', async () => {
    const tenantAToken = 'tenant-a-admin-token';
    const tenantBToken = 'tenant-b-admin-token';
    await seedSessionUser({
      id: 'usr_tenant_a',
      name: 'Tenant A Admin',
      email: 'admin-a@example.com',
      role: 'admin',
      token: tenantAToken,
      workspaceId: 'ws_tenant_a',
    });
    await seedSessionUser({
      id: 'usr_tenant_b',
      name: 'Tenant B Admin',
      email: 'admin-b@example.com',
      role: 'admin',
      token: tenantBToken,
      workspaceId: 'ws_tenant_b',
    });

    const created = await createInvite({ email: 'tenant-a-invitee@example.com', role: 'member' }, tenantAToken);
    expect(created.status).toBe(201);
    const inviteId = created.body.invite.id;

    const listA = await listInvites(tenantAToken);
    expect(listA.status).toBe(200);
    expect(listA.body.invites.some((i) => i.id === inviteId)).toBe(true);

    const listB = await listInvites(tenantBToken);
    expect(listB.status).toBe(200);
    expect(listB.body.invites).toHaveLength(0);

    expect((await resendInvite(inviteId, tenantBToken)).status).toBe(404);
    expect((await revokeInvite(inviteId, tenantBToken)).status).toBe(404);
    expect((await request(app).delete(`/api/team/invites/${inviteId}`).set(auth(tenantBToken))).status).toBe(404);

    const stored = await storedInvite('tenant-a-invitee@example.com');
    expect(stored.workspaceId).toBe('ws_tenant_a');
    expect(stored.status).toBe('pending');
  });
});

describe('role validation & escalation guard', () => {
  it('allows admin, member, viewer roles', async () => {
    for (const [role, email] of [
      ['admin', 'role-admin@example.com'],
      ['member', 'role-member@example.com'],
      ['viewer', 'role-viewer@example.com'],
    ]) {
      const res = await createInvite({ email, role });
      expect(res.status).toBe(201);
      expect(res.body.invite.role).toBe(role);
    }
  });

  it('rejects owner and prototype-pollution keys with 400', async () => {
    const owner = await createInvite({ email: 'owner-attempt@example.com', role: 'owner' });
    expect(owner.status).toBe(400);

    const protoBody = await request(app)
      .post('/api/team/invites')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send('{"email":"proto1@example.com","__proto__":{"polluted":true}}');
    expect(protoBody.status).toBe(400);

    for (const payload of [
      { email: 'proto2@example.com', constructor: { polluted: true } },
      { email: 'proto3@example.com', prototype: { polluted: true } },
    ]) {
      const res = await createInvite(payload);
      expect(res.status).toBe(400);
    }
  });
});

describe('lifecycle & single-use acceptance', () => {
  it('validates pending token publicly without consuming it', async () => {
    const created = await createInvite({ email: 'validate@example.com' });
    const token = tokenFromJoinUrl(created.body.joinUrl);
    const first = await validateToken(token);
    const second = await validateToken(token);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ valid: true, expired: false, status: 'pending', email: 'validate@example.com' });
    expect(second.status).toBe(200);
    expect(second.body.valid).toBe(true);
    const stored = await storedInvite('validate@example.com');
    expect(stored.status).toBe('pending');
  });

  it('rejects expired token on validation/acceptance (400 on accept)', async () => {
    const created = await createInvite({ email: 'expired@example.com' });
    const token = tokenFromJoinUrl(created.body.joinUrl);
    await expireInviteByEmail('expired@example.com');

    const validate = await validateToken(token);
    expect(validate.status).toBe(200);
    expect(validate.body).toMatchObject({ valid: false, expired: true, status: 'expired' });

    const accept = await acceptInvite({ token, name: 'Late User', password: 'secret123' });
    expect(accept.status).toBe(400);
    expect(String(accept.body.error || '')).toMatch(/expired/i);
  });

  it('resend rotates token and invalidates prior token', async () => {
    const created = await createInvite({ email: 'resend@example.com' });
    const tokenOne = tokenFromJoinUrl(created.body.joinUrl);
    const resent = await resendInvite(created.body.invite.id);
    expect(resent.status).toBe(200);
    const tokenTwo = tokenFromJoinUrl(resent.body.joinUrl);
    expect(tokenTwo).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenTwo).not.toBe(tokenOne);

    expect((await validateToken(tokenOne)).status).toBe(404);
    expect((await validateToken(tokenTwo)).status).toBe(200);
  });

  it('soft revocation blocks subsequent validation/acceptance with 404', async () => {
    const created = await createInvite({ email: 'revoked@example.com' });
    const token = tokenFromJoinUrl(created.body.joinUrl);
    const revoked = await revokeInvite(created.body.invite.id);
    expect(revoked.status).toBe(200);
    expect(revoked.body.invite.status).toBe('revoked');

    expect((await validateToken(token)).status).toBe(404);
    expect((await acceptInvite({ token, name: 'Revoked User', password: 'secret123' })).status).toBe(404);
  });

  it('accepts once with workspace inheritance and #450-compatible refresh token/cookie; replay is 404', async () => {
    const tenantToken = 'tenant-accept-admin-token';
    await seedSessionUser({
      id: 'usr_tenant_accept',
      name: 'Tenant Accept Admin',
      email: 'accept-admin@example.com',
      role: 'admin',
      token: tenantToken,
      workspaceId: 'ws_accept',
    });

    const created = await createInvite({ email: 'accepted@example.com', role: 'member' }, tenantToken);
    expect(created.status).toBe(201);
    const token = tokenFromJoinUrl(created.body.joinUrl);

    const accepted = await acceptInvite({ token, name: 'Accepted User', password: 'secret123' }, '/api/auth/accept-invite');
    expect(accepted.status).toBe(201);
    expect(accepted.body.user).toMatchObject({ email: 'accepted@example.com', role: 'member' });
    expect(typeof accepted.body.token).toBe('string');
    expect(typeof accepted.body.refreshToken).toBe('string');
    expect(typeof accepted.body.expiresIn).toBe('number');

    const setCookie = accepted.headers['set-cookie'] || [];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
    expect(cookieHeader).toMatch(/tunaxa_refresh=/);

    const db = await readDb();
    const user = db.users.find((u) => u.email === 'accepted@example.com');
    expect(user).toBeTruthy();
    expect(user.workspaceId).toBe('ws_accept');

    const stored = await storedInvite('accepted@example.com');
    expect(stored.status).toBe('accepted');

    const refresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookieHeader)
      .send({});
    expect(refresh.status).toBe(200);
    expect(typeof refresh.body.token).toBe('string');

    expect((await acceptInvite({ token, name: 'Replay', password: 'secret123' })).status).toBe(404);
  });
});
