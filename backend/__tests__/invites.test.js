import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import { mutateDb, readDb } from '../store.js';
import { sendEmail } from '../services/email.js';

// Never send real email during tests; capture the payload instead.
vi.mock('../services/email.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sendEmail: vi.fn(async () => ({ delivered: true, status: 'Sent' })),
  };
});

let app;
let token;
let inviteToken;

const tokenFromJoinUrl = (url) => {
  const match = String(url || '').match(/token=([a-f0-9]{64})/i);
  return match ? match[1] : null;
};

beforeAll(async () => {
  await resetTestDb();
  await mutateDb((db) => {
    db.settings = { ...(db.settings || {}), publicBaseUrl: 'https://app.example.com' };
  });
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
});

afterAll(() => cleanupTestDb());

describe('Team invitations (compat endpoints)', () => {
  it('POST /api/users/invite requires authentication and admin role', async () => {
    const noAuth = await request(app).post('/api/users/invite').send({ email: 'x@example.com' });
    expect(noAuth.status).toBe(401);

    const created = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Member One', email: 'member-one@example.com', password: 'secret123' })
      .expect(201);
    expect(created.body.role).toBe('member');

    const memberLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'member-one@example.com', password: 'secret123' })
      .expect(200);

    const forbidden = await request(app)
      .post('/api/users/invite')
      .set('Authorization', `Bearer ${memberLogin.body.token}`)
      .send({ email: 'x@example.com' });
    expect(forbidden.status).toBe(403);
  });

  it('POST /api/users/invite rejects an invalid email', async () => {
    const res = await request(app)
      .post('/api/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('POST /api/users/invite rejects an email that already has a user', async () => {
    const res = await request(app)
      .post('/api/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'test@test.com' });
    expect(res.status).toBe(409);
  });

  it('POST /api/users/invite persists a hashed invite and provides a join link', async () => {
    sendEmail.mockClear();
    const res = await request(app)
      .post('/api/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'New.Hire@Example.com' })
      .expect(201);

    expect(res.body.invite).toBeTruthy();
    expect(res.body.invite.email).toBe('new.hire@example.com');
    expect(res.body.invite.status).toBe('pending');
    expect(res.body.invite).not.toHaveProperty('token');
    expect(res.body.invite).not.toHaveProperty('tokenHash');
    expect(new Date(res.body.invite.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.joinUrl).toContain('https://app.example.com/accept-invite?token=');

    inviteToken = tokenFromJoinUrl(res.body.joinUrl);
    expect(inviteToken).toMatch(/^[a-f0-9]{64}$/i);

    const db = await readDb();
    const invitations = db.invitations || [];
    expect(invitations).toHaveLength(1);
    const invite = invitations[0];
    expect(invite.email).toBe('new.hire@example.com');
    expect(invite.token).toBeUndefined();
    expect(invite.tokenHash).toBe(crypto.createHash('sha256').update(inviteToken).digest('hex'));
    expect(invite.invitedBy).toBe('usr_test');
    expect(invite.createdAt).toBeTruthy();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][1];
    expect(mail.to).toBe('new.hire@example.com');
    expect(String(mail.subject || '')).toMatch(/invited/i);
    expect(String(mail.text || '') + String(mail.html || '')).toContain(inviteToken);
  });

  it('POST /api/auth/accept-invite provisions the member and returns a session', async () => {
    const res = await request(app).post('/api/auth/accept-invite').send({
      token: inviteToken,
      name: '  New Hire  ',
      password: 'secret123',
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(typeof res.body.expiresIn).toBe('number');
    expect(res.body.user.name).toBe('New Hire');
    expect(res.body.user.email).toBe('new.hire@example.com');
    expect(res.body.user.role).toBe('member');
    expect(res.body.user.password).toBeUndefined();

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`)
      .expect(200);
    expect(me.body.user.email).toBe('new.hire@example.com');

    const db = await readDb();
    const user = db.users.find((u) => u.email === 'new.hire@example.com');
    expect(user).toBeTruthy();
    expect(user.role).toBe('member');
    const member = db.team.find((t) => t.email === 'new.hire@example.com');
    expect(member).toBeTruthy();
    expect(member.role).toBe('member');
    expect(member.status).toBe('Active');
    const invite = (db.invitations || []).find((i) => i.email === 'new.hire@example.com');
    expect(invite?.status).toBe('accepted');
  });

  it('POST /api/auth/accept-invite rejects a used token', async () => {
    const res = await request(app).post('/api/auth/accept-invite').send({
      token: inviteToken,
      name: 'Again',
      password: 'secret123',
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/auth/accept-invite rejects an unknown token', async () => {
    const res = await request(app).post('/api/auth/accept-invite').send({
      token: 'f'.repeat(64),
      name: 'Ghost',
      password: 'secret123',
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/auth/accept-invite requires name and password', async () => {
    const missing = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token: 'f'.repeat(64) });
    expect(missing.status).toBe(400);

    const short = await request(app).post('/api/auth/accept-invite').send({
      token: 'f'.repeat(64),
      name: 'Ghost',
      password: '123',
    });
    expect(short.status).toBe(400);
  });

  it('POST /api/auth/accept-invite rejects an expired token', async () => {
    await mutateDb((db) => {
      db.invitations = db.invitations || [];
      db.invitations.push({
        id: 'inv_expired',
        email: 'expired@example.com',
        role: 'member',
        tokenHash: crypto.createHash('sha256').update('a'.repeat(64)).digest('hex'),
        status: 'pending',
        workspaceId: 'default',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
        invitedBy: 'usr_test',
      });
    });
    const res = await request(app).post('/api/auth/accept-invite').send({
      token: 'a'.repeat(64),
      name: 'Late Arrival',
      password: 'secret123',
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/accept-invite rejects an invite whose email already has a user', async () => {
    await mutateDb((db) => {
      db.invitations = db.invitations || [];
      db.invitations.push({
        id: 'inv_dup',
        email: 'member-one@example.com',
        role: 'member',
        tokenHash: crypto.createHash('sha256').update('b'.repeat(64)).digest('hex'),
        status: 'pending',
        workspaceId: 'default',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
        invitedBy: 'usr_test',
      });
    });
    const res = await request(app).post('/api/auth/accept-invite').send({
      token: 'b'.repeat(64),
      name: 'Duplicate',
      password: 'secret123',
    });
    expect(res.status).toBe(409);
  });
});
