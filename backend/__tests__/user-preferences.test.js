import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { closePool } from '../db/pg.js';
import { readDb, mutateDb } from '../store.js';
import { hashPassword } from '../helpers.js';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';


const SECOND_USER_ID = 'usr_second';
const SECOND_TOKEN = 'second-user-session-token';

let app;
let token;

const auth = (bearer = token) => ({ Authorization: `Bearer ${bearer}` });

const getPrefs = (bearer) =>
  request(app).get('/api/user/preferences').set(auth(bearer));

const putPrefs = (body, bearer) =>
  request(app).put('/api/user/preferences').set(auth(bearer)).send(body);

const patchPrefs = (body, bearer) =>
  request(app).patch('/api/user/preferences').set(auth(bearer)).send(body);

const resetPrefs = async (userId) => {
  await mutateDb((db) => {
    const user = db.users.find((item) => item.id === userId);
    if (user) user.preferences = {};
    if (db.settings?.userPreferences) delete db.settings.userPreferences[userId];
  });
};

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);

  await mutateDb((db) => {
    db.users.push({
      id: SECOND_USER_ID,
      name: 'Second User',
      email: 'second@test.com',
      password: hashPassword('test123'),
      role: 'member',
      createdAt: new Date().toISOString(),
    });
    db.sessions.push({
      token: SECOND_TOKEN,
      userId: SECOND_USER_ID,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  });
});

afterAll(async () => {
  await closePool();
  await cleanupTestDb();
});

describe('authentication', () => {
  it('requires a bearer token on every verb', async () => {
    expect((await request(app).get('/api/user/preferences')).status).toBe(401);
    expect(
      (await request(app).put('/api/user/preferences').send({ theme: 'dark' })).status,
    ).toBe(401);
    expect(
      (await request(app).patch('/api/user/preferences').send({ theme: 'dark' })).status,
    ).toBe(401);
  });
});

describe('GET /api/user/preferences', () => {
  it('returns the server-side defaults when nothing is stored', async () => {
    const res = await getPrefs();
    expect(res.status).toBe(200);
    expect(res.body.preferences).toEqual({
      theme: 'system',
      density: 'comfortable',
      columnVisibility: {},
    });
  });
});

describe('PUT /api/user/preferences', () => {
  it('persists theme, density and columnVisibility and returns the stored contract', async () => {
    await resetPrefs('usr_test');
    const res = await putPrefs({
      theme: 'dark',
      density: 'spacious',
      columnVisibility: {
        contacts: ['firstName', 'email'],
        deals: ['title', 'value'],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.preferences).toEqual({
      theme: 'dark',
      density: 'spacious',
      columnVisibility: {
        contacts: ['firstName', 'email'],
        deals: ['title', 'value'],
      },
    });

    const read = await getPrefs();
    expect(read.body.preferences).toEqual(res.body.preferences);
  });

  it('accepts boolean visibility flags as well as column arrays', async () => {
    await resetPrefs('usr_test');
    const res = await putPrefs({
      columnVisibility: { tickets: true, activities: false },
    });
    expect(res.status).toBe(200);
    expect(res.body.preferences.columnVisibility).toEqual({
      tickets: true,
      activities: false,
    });
  });
});

describe('PATCH /api/user/preferences', () => {
  it('deep-merges columnVisibility so a theme update never drops the column map', async () => {
    await resetPrefs('usr_test');
    await putPrefs({
      theme: 'dark',
      density: 'compact',
      columnVisibility: { contacts: ['firstName'], deals: ['title'] },
    });

    const res = await patchPrefs({
      theme: 'light',
      columnVisibility: { contacts: ['email'] },
    });

    expect(res.status).toBe(200);
    expect(res.body.preferences.theme).toBe('light');
    expect(res.body.preferences.density).toBe('compact');
    expect(res.body.preferences.columnVisibility).toEqual({
      contacts: ['email'],
      deals: ['title'],
    });
  });

  it('preserves unrelated stored preference keys (legacy sidebar/pageSize)', async () => {
    await mutateDb((db) => {
      const user = db.users.find((item) => item.id === 'usr_test');
      user.preferences = { sidebarCollapsed: true, pageSize: 50 };
    });

    const res = await patchPrefs({ theme: 'dark' });
    expect(res.status).toBe(200);
    expect(res.body.preferences.theme).toBe('dark');

    const db = await readDb();
    const user = db.users.find((item) => item.id === 'usr_test');
    expect(user.preferences.sidebarCollapsed).toBe(true);
    expect(user.preferences.pageSize).toBe(50);
  });
});

describe('validation and security guards', () => {
  it('rejects an out-of-contract theme', async () => {
    const res = await putPrefs({ theme: 'blue' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/theme/);
  });

  it('rejects an out-of-contract density', async () => {
    const res = await patchPrefs({ density: 'cramped' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/density/);
  });

  it('rejects unknown top-level keys', async () => {
    const res = await putPrefs({ colour: 'red' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/colour/);
  });

  it('rejects a malformed columnVisibility map', async () => {
    const notObject = await putPrefs({ columnVisibility: ['contacts'] });
    expect(notObject.status).toBe(400);

    const badValue = await putPrefs({ columnVisibility: { contacts: 42 } });
    expect(badValue.status).toBe(400);

    const badColumn = await putPrefs({ columnVisibility: { contacts: ['email', ''] } });
    expect(badColumn.status).toBe(400);
  });

  it('rejects prototype-pollution keys without touching Object.prototype', async () => {
    const res = await request(app)
      .put('/api/user/preferences')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send('{"theme":"dark","__proto__":{"polluted":true}}');
    expect(res.status).toBe(400);
    expect({}.polluted).toBeUndefined();

    const ctor = await request(app)
      .patch('/api/user/preferences')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send('{"density":"compact","constructor":{"polluted":true}}');
    expect(ctor.status).toBe(400);
    expect({}.polluted).toBeUndefined();

    const proto = await request(app)
      .patch('/api/user/preferences')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send('{"density":"compact","prototype":{"polluted":true}}');
    expect(proto.status).toBe(400);
    expect({}.polluted).toBeUndefined();
  });

  it('rejects an oversized payload', async () => {
    const columnVisibility = {};
    for (let r = 0; r < 200; r++) {
      columnVisibility[`resource_${r}`] = Array.from(
        { length: 200 },
        (_, c) => `column_name_${c}`,
      );
    }
    const res = await putPrefs({ columnVisibility });
    expect(res.status).toBe(413);
  });
});

describe('isolation', () => {
  it('keeps preferences scoped to the authenticated user', async () => {
    await resetPrefs('usr_test');
    await resetPrefs(SECOND_USER_ID);

    await putPrefs({
      theme: 'dark',
      density: 'spacious',
      columnVisibility: { contacts: ['email'] },
    });
    await putPrefs(
      {
        theme: 'light',
        density: 'compact',
        columnVisibility: { deals: ['title'] },
      },
      SECOND_TOKEN,
    );

    const first = await getPrefs();
    const second = await getPrefs(SECOND_TOKEN);

    expect(first.body.preferences).toEqual({
      theme: 'dark',
      density: 'spacious',
      columnVisibility: { contacts: ['email'] },
    });
    expect(second.body.preferences).toEqual({
      theme: 'light',
      density: 'compact',
      columnVisibility: { deals: ['title'] },
    });
  });
});

describe('legacy interoperability', () => {
  it('reflects /api/user/preferences theme updates in /api/users/me/preferences without breaking it', async () => {
    await resetPrefs('usr_test');

    const putNew = await putPrefs({ theme: 'dark' });
    expect(putNew.status).toBe(200);

    const legacy = await request(app)
      .get('/api/users/me/preferences')
      .set(auth());
    expect(legacy.status).toBe(200);
    expect(legacy.body.preferences.theme).toBe('dark');
    expect(typeof legacy.body.preferences.sidebarCollapsed).toBe('boolean');
    expect(typeof legacy.body.preferences.tablePageSize).toBe('number');
    expect(typeof legacy.body.preferences.pageSize).toBe('number');
    expect(legacy.body.preferences.pageSize).toBe(legacy.body.preferences.tablePageSize);
  });
});