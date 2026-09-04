import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { query, closePool } from '../db/pg.js';
import { resetTestDb, seedTestUser, loginAs } from './setup.js';

let app, token;

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
});

afterAll(async () => {
  await closePool();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('Audit Log', () => {
  it('GET /api/audit lists audit entries', async () => {
    const res = await request(app).get('/api/audit').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items).toBeDefined();
    expect(res.body.total).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/audit/stats returns stats', async () => {
    const res = await request(app).get('/api/audit/stats').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.total).toBeDefined();
    expect(res.body.byActor).toBeDefined();
    expect(res.body.byAction).toBeDefined();
  });

  it('GET /api/audit filters by actor', async () => {
    const res = await request(app).get('/api/audit?actor=Test User').set(auth());
    expect(res.status).toBe(200);
  });

  it('GET /api/audit limits results', async () => {
    const res = await request(app).get('/api/audit?limit=5').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(5);
  });
});

describe('Users & RBAC', () => {
  it('GET /api/users lists users', async () => {
    const res = await request(app).get('/api/users').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/users creates a new user', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth())
      .send({ name: 'New Member', email: 'member@test.com', password: 'pass123' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('New Member');
    expect(res.body.role).toBe('member');
  });

  it('POST /api/users rejects duplicate email', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth())
      .send({ name: 'Dup', email: 'member@test.com', password: 'pass123' });
    expect(res.status).toBe(409);
  });

  it('PATCH /api/users/:id/role changes role', async () => {
    const list = await request(app).get('/api/users').set(auth());
    const user = list.body.find(u => u.email === 'member@test.com');
    const res = await request(app)
      .patch(`/api/users/${user.id}/role`)
      .set(auth())
      .send({ role: 'viewer' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('viewer');
  });

  it('PATCH /api/users/:id/role rejects invalid role', async () => {
    const list = await request(app).get('/api/users').set(auth());
    const user = list.body.find(u => u.email === 'member@test.com');
    const res = await request(app)
      .patch(`/api/users/${user.id}/role`)
      .set(auth())
      .send({ role: 'superadmin' });
    expect(res.status).toBe(400);
  });

  it('DELETE /api/users/:id removes user', async () => {
    const list = await request(app).get('/api/users').set(auth());
    const user = list.body.find(u => u.email === 'member@test.com');
    const res = await request(app).delete(`/api/users/${user.id}`).set(auth());
    expect(res.status).toBe(200);
  });

  it('DELETE /api/users/:id cannot delete self', async () => {
    const list = await request(app).get('/api/users').set(auth());
    const self = list.body.find(u => u.email === 'test@test.com');
    const res = await request(app).delete(`/api/users/${self.id}`).set(auth());
    expect(res.status).toBe(400);
  });
});

describe('SSE Events', () => {
  it('GET /api/events/clients returns count', async () => {
    const res = await request(app).get('/api/events/clients').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.count).toBeDefined();
  });
});

describe('Rate Limiting', () => {
  it('Global rate limiter allows normal requests', async () => {
    const res = await request(app).get('/api/dashboard').set(auth());
    expect(res.status).toBe(200);
  });
});
