import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import { mutateDb, readDb } from '../store.js';
import { sendEmail } from '../services/smtp.js';

// Never send real email during tests; capture the payload instead.
vi.mock('../services/smtp.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sendEmail: vi.fn(async () => ({ delivered: true, status: 'Sent' })),
  };
});

let app;
let token;
let inviteToken;

const ACCEPT_BASE = 'https://app.example.com/accept-invite?token=';

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

beforeEach(() => {
  sendEmail.mockClear();
});

afterAll(() => cleanupTestDb());

describe('Team invitations', () => {
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

  it('POST /api/users/invite persists the invite and emails the accept link', async () => {
    const res = await request(app)
      .post('/api/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'New.Hire@Example.com' })
      .expect(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.email).toBe('new.hire@example.com');
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(
      Date.now() + 47 * 60 * 60 * 1000,
    );
    expect(res.body.token).toBeUndefined();

    const db = await readDb();
    expect(db.invites).toHaveLength(1);
    const invite = db.invites[0];
    expect(invite.email).toBe('new.hire@example.com');
    expect(invite.token).toMatch(/^[0-9a-f]{64}$/);
    expect(invite.createdBy).toBe('usr_test');
    expect(invite.createdAt).toBeTruthy();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][1];
    expect(mail.to).toBe('new.hire@example.com');
    expect(mail.subject).toContain('invited');
    expect(mail.text).toContain(ACCEPT_BASE);
    const match = mail.text.match(/token=([0-9a-f]{64})/);
    expect(match).toBeTruthy();
    inviteToken = match[1];
  });

  it('POST /api/auth/accept-invite provisions the member and returns a session', async () => {
    const res = await request(app).post('/api/auth/accept-invite').send({
      token: inviteToken,
      name: '  New Hire  ',
      password: 'secret123',
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
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
    expect(db.invites.some((entry) => entry.token === inviteToken)).toBe(false);
  });

  it('POST /api/auth/accept-invite rejects a used token', async () => {
    const res = await request(app).post('/api/auth/accept-invite').send({
      token: inviteToken,
      name: 'Again',
      password: 'secret123',
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/accept-invite rejects an unknown token', async () => {
    const res = await request(app).post('/api/auth/accept-invite').send({
      token: 'f'.repeat(64),
      name: 'Ghost',
      password: 'secret123',
    });
    expect(res.status).toBe(400);
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
      db.invites = db.invites || [];
      db.invites.push({
        id: 'inv_expired',
        email: 'expired@example.com',
        token: 'a'.repeat(64),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
        createdBy: 'usr_test',
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
      db.invites = db.invites || [];
      db.invites.push({
        id: 'inv_dup',
        email: 'member-one@example.com',
        token: 'b'.repeat(64),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
        createdBy: 'usr_test',
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