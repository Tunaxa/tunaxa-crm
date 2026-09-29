import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb } from './setup.js';
import { readDb } from '../store.js';

let app;

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
});

afterAll(() => cleanupTestDb());

describe('User preferences API storage + mapping', () => {
  let token;
  let userId;

  beforeAll(async () => {
    const setup = await request(app).post('/api/auth/setup').send({
      name: 'Pref Owner',
      email: 'prefs@test.com',
      password: 'secret123',
    });
    expect(setup.status).toBe(200);
    userId = setup.body.user.id;

    const login = await request(app).post('/api/auth/login').send({
      email: 'prefs@test.com',
      password: 'secret123',
    });
    expect(login.status).toBe(200);
    token = login.body.token;
  });

  it('returns defaults before any save', async () => {
    const res = await request(app)
      .get('/api/users/me/preferences')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.preferences).toEqual({
      theme: 'light',
      sidebarCollapsed: false,
      tablePageSize: 25,
      pageSize: 25,
    });
  });

  it('PUT writes to db.settings.userPreferences[userId] (not the users array)', async () => {
    const res = await request(app)
      .put('/api/users/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ theme: 'dark', sidebarCollapsed: true, pageSize: 50 });
    expect(res.status).toBe(200);
    expect(res.body.preferences).toEqual({
      theme: 'dark',
      sidebarCollapsed: true,
      tablePageSize: 50,
      pageSize: 50,
    });

    const db = await readDb();
    expect(db.settings.userPreferences).toBeDefined();
    expect(db.settings.userPreferences[userId]).toEqual({
      theme: 'dark',
      sidebarCollapsed: true,
      tablePageSize: 50,
    });
    const user = db.users.find((u) => u.email === 'prefs@test.com');
    expect(user.preferences).toBeUndefined();
  });

  it('GET retrieves the preferences stored in settings', async () => {
    const res = await request(app)
      .get('/api/users/me/preferences')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.preferences).toEqual({
      theme: 'dark',
      sidebarCollapsed: true,
      tablePageSize: 50,
      pageSize: 50,
    });
  });

  it('PUT accepts the canonical tablePageSize property name', async () => {
    const res = await request(app)
      .put('/api/users/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ tablePageSize: 40 });
    expect(res.status).toBe(200);

    const get = await request(app)
      .get('/api/users/me/preferences')
      .set('Authorization', `Bearer ${token}`);
    expect(get.body.preferences.tablePageSize).toBe(40);
    expect(get.body.preferences.pageSize).toBe(40);
  });

  it('prefers tablePageSize when both pageSize and tablePageSize are sent', async () => {
    const res = await request(app)
      .put('/api/users/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ pageSize: 60, tablePageSize: 55 });
    expect(res.status).toBe(200);

    const get = await request(app)
      .get('/api/users/me/preferences')
      .set('Authorization', `Bearer ${token}`);
    expect(get.body.preferences.tablePageSize).toBe(55);
    expect(get.body.preferences.pageSize).toBe(55);
  });

  it('partial PUT merges with existing preferences', async () => {
    const res = await request(app)
      .put('/api/users/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ sidebarCollapsed: false });
    expect(res.status).toBe(200);

    const get = await request(app)
      .get('/api/users/me/preferences')
      .set('Authorization', `Bearer ${token}`);
    expect(get.body.preferences).toEqual({
      theme: 'dark',
      sidebarCollapsed: false,
      tablePageSize: 55,
      pageSize: 55,
    });
  });

  it('PUT rejects an invalid theme', async () => {
    const res = await request(app)
      .put('/api/users/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ theme: 'neon' });
    expect(res.status).toBe(400);
  });

  it('PUT rejects a non-boolean sidebarCollapsed', async () => {
    const res = await request(app)
      .put('/api/users/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ sidebarCollapsed: 'yes' });
    expect(res.status).toBe(400);
  });

  it('PUT rejects non-positive or non-numeric page sizes', async () => {
    for (const pageSize of [0, -5, '50', null]) {
      const res = await request(app)
        .put('/api/users/me/preferences')
        .set('Authorization', `Bearer ${token}`)
        .send({ pageSize });
      expect(res.status).toBe(400);
    }
  });

  it('GET and PUT require authentication', async () => {
    const get = await request(app).get('/api/users/me/preferences');
    expect(get.status).toBe(401);

    const put = await request(app).put('/api/users/me/preferences').send({ theme: 'dark' });
    expect(put.status).toBe(401);
  });

  it('login response surfaces the stored preferences (frontend init)', async () => {
    const res = await request(app)
      .put('/api/users/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ theme: 'dark', pageSize: 100 });
    expect(res.status).toBe(200);

    const login = await request(app).post('/api/auth/login').send({
      email: 'prefs@test.com',
      password: 'secret123',
    });
    expect(login.status).toBe(200);
    expect(login.body.user.preferences).toMatchObject({ theme: 'dark', pageSize: 100 });
  });

  it('GET /api/auth/me surfaces the stored preferences', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'prefs@test.com', password: 'secret123' });
    expect(login.status).toBe(200);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.preferences).toMatchObject({ theme: 'dark', pageSize: 100 });
  });
});