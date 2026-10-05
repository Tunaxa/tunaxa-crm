import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb } from './setup.js';
import { mutateDb } from '../store.js';

let app;

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
});

afterAll(() => cleanupTestDb());

describe('Health', () => {
  it('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Auth status', () => {
  it('GET /api/auth/status needsSetup true when no users', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(true);
  });
});

describe('Auth setup', () => {
  it('POST /api/auth/setup creates workspace', async () => {
    const res = await request(app).post('/api/auth/setup').send({
      name: 'Test Owner',
      email: 'admin@test.com',
      password: 'secret123'
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.name).toBe('Test Owner');
    expect(res.body.user.email).toBe('admin@test.com');
    expect(res.body.user.role).toBe('Owner');
  });

  it('POST /api/auth/setup rejects duplicate', async () => {
    const res = await request(app).post('/api/auth/setup').send({
      name: 'Another',
      email: 'other@test.com',
      password: 'secret123'
    });
    expect(res.status).toBe(409);
  });
});

describe('Auth validation', () => {
  it('POST /api/auth/setup rejects missing name', async () => {
    const res = await request(app).post('/api/auth/setup').send({
      email: 'x@test.com',
      password: 'secret123'
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/setup rejects short password', async () => {
    const res = await request(app).post('/api/auth/setup').send({
      name: 'X',
      email: 'x@test.com',
      password: '123'
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/setup rejects invalid email', async () => {
    const res = await request(app).post('/api/auth/setup').send({
      name: 'X',
      email: 'not-an-email',
      password: 'secret123'
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/login rejects wrong password', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'admin@test.com',
      password: 'wrong'
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/login rejects missing email', async () => {
    const res = await request(app).post('/api/auth/login').send({
      password: 'secret123'
    });
    expect(res.status).toBe(400);
  });
});

describe('Auth login + me + logout', () => {
  let token;

  it('POST /api/auth/login returns token', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'admin@test.com',
      password: 'secret123'
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    token = res.body.token;
  });

  it('POST /api/auth/refresh rotates the token and invalidates the old token', async () => {
    const oldToken = token;
    const res = await request(app).post('/api/auth/refresh').set('Authorization', `Bearer ${oldToken}`);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.token).not.toBe(oldToken);

    const oldMe = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${oldToken}`);
    expect(oldMe.status).toBe(401);

    token = res.body.token;
    const newMe = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(newMe.status).toBe(200);
  });

  it('GET /api/auth/me returns user', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('admin@test.com');
  });

  it('GET /api/auth/me rejects no token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/refresh rejects no token', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/logout invalidates token', async () => {
    const res = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(401);
  });

  it('POST /api/auth/refresh rejects an expired token', async () => {
    const login = await request(app).post('/api/auth/login').send({
      email: 'admin@test.com',
      password: 'secret123'
    });
    await mutateDb(db => {
      const session = db.sessions.find(item => item.token === login.body.token);
      session.expiresAt = new Date(0).toISOString();
    });

    const res = await request(app).post('/api/auth/refresh').set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(401);
  });
});
