import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import { mutateDb, readDb } from '../store.js';

let app;
let token;
let viewerToken;

const asOwner = (req) => req.set('Authorization', `Bearer ${token}`);

const patch = (resource, id, body, bearer = token) =>
  request(app)
    .patch(`/api/${resource}/${id}`)
    .set('Authorization', `Bearer ${bearer}`)
    .send(body);

const getOne = (resource, id) =>
  request(app).get(`/api/${resource}/${id}`).set('Authorization', `Bearer ${token}`);

const createContact = async (overrides = {}) => {
  const res = await asOwner(request(app).post('/api/contacts')).send({
    name: 'Ada Lovelace',
    email: 'ada@test.com',
    phone: '555-0100',
    role: 'CTO',
    company: 'Analytical Engines',
    owner: 'Test User',
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body;
};

// updatedAt is refreshed by an update and revisionId is added to the response, so
// both are excluded when comparing the rest of the record.
const stripMeta = (record) => {
  const copy = { ...record };
  delete copy.updatedAt;
  delete copy.revisionId;
  return copy;
};

// The shared setup hook spawns `npm run migrate` and importing the server pulls in
// every route module, which can exceed vitest's 10s default on a cold cache.
beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);

  // A second account with a role outside EDIT_ROLES, to prove PATCH is guarded
  // by exactly the same middleware chain as PUT.
  const salt = crypto.randomBytes(16).toString('hex');
  const password = `${salt}:${crypto.scryptSync('test123', salt, 64).toString('hex')}`;
  await mutateDb((db) => {
    db.users.push({
      id: 'usr_viewer',
      name: 'Read Only',
      email: 'viewer@test.com',
      password,
      role: 'viewer',
      createdAt: new Date().toISOString(),
    });
  });
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'viewer@test.com', password: 'test123' });
  viewerToken = login.body.token;
}, 60_000);

afterAll(() => cleanupTestDb());

describe('PATCH /api/:resource/:id - true partial update', () => {
  it('updates only the field that was sent', async () => {
    const before = await createContact();

    const res = await patch('contacts', before.id, { phone: '555-0199' });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('555-0199');
    for (const key of ['name', 'email', 'role', 'company', 'owner']) {
      expect(res.body[key]).toBe(before[key]);
    }
  });

  it('returns 200 with the complete updated record, not just the sent field', async () => {
    const before = await createContact();

    const res = await patch('contacts', before.id, { phone: '555-0199' });

    expect(res.status).toBe(200);
    for (const key of Object.keys(before)) {
      expect(res.body).toHaveProperty(key);
    }
  });

  it('persists the merge to the store', async () => {
    const before = await createContact();

    await patch('contacts', before.id, { phone: '555-0199' });

    const stored = await getOne('contacts', before.id);
    expect(stored.status).toBe(200);
    expect(stored.body.phone).toBe('555-0199');
    expect(stored.body.name).toBe(before.name);
    expect(stored.body.email).toBe(before.email);
    expect(stored.body.createdAt).toBe(before.createdAt);

    // Also confirm it reached disk, not just the response.
    const db = await readDb();
    const row = db.contacts.find((c) => c.id === before.id);
    expect(row.phone).toBe('555-0199');
    expect(row.name).toBe(before.name);
  });

  it('leaves untouched fields byte-identical after several sequential patches', async () => {
    const before = await createContact();

    await patch('contacts', before.id, { phone: '555-0199' });
    await patch('contacts', before.id, { role: 'Chief Engineer' });
    await patch('contacts', before.id, { company: 'Difference Engines' });

    const stored = await getOne('contacts', before.id);
    expect(stored.body.phone).toBe('555-0199');
    expect(stored.body.role).toBe('Chief Engineer');
    expect(stored.body.company).toBe('Difference Engines');
    expect(stored.body.name).toBe(before.name);
    expect(stored.body.email).toBe(before.email);
    expect(stored.body.owner).toBe(before.owner);
    expect(stored.body.createdAt).toBe(before.createdAt);
  });

  it('refreshes updatedAt', async () => {
    const created = await createContact();
    const stale = '2000-01-01T00:00:00.000Z';
    await mutateDb((db) => {
      db.contacts.find((c) => c.id === created.id).updatedAt = stale;
    });

    const res = await patch('contacts', created.id, { phone: '555-0199' });

    expect(res.body.updatedAt).not.toBe(stale);
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(
      new Date(stale).getTime(),
    );
  });

  it('does not let the payload change the id', async () => {
    const before = await createContact();

    const res = await patch('contacts', before.id, { id: 'hijacked_id', phone: '555-0199' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(before.id);

    const db = await readDb();
    expect(db.contacts.some((c) => c.id === 'hijacked_id')).toBe(false);
  });

  it('does not let the payload rewind createdAt', async () => {
    const before = await createContact();

    const res = await patch('contacts', before.id, {
      createdAt: '1999-01-01T00:00:00.000Z',
    });

    expect(res.status).toBe(200);
    expect(res.body.createdAt).toBe(before.createdAt);
  });

  it('applies several sent fields at once and still keeps the rest', async () => {
    const before = await createContact();

    const res = await patch('contacts', before.id, {
      phone: '555-0199',
      role: 'Chief Engineer',
    });

    expect(res.body.phone).toBe('555-0199');
    expect(res.body.role).toBe('Chief Engineer');
    expect(res.body.name).toBe(before.name);
    expect(res.body.email).toBe(before.email);
  });

  it('adds a field the record did not previously have without dropping the others', async () => {
    const before = await createContact();

    const res = await patch('contacts', before.id, { linkedin: 'https://linkedin.com/in/ada' });

    expect(res.body.linkedin).toBe('https://linkedin.com/in/ada');
    expect(res.body.name).toBe(before.name);
    expect(res.body.email).toBe(before.email);
    expect(res.body.phone).toBe(before.phone);
  });

  it('treats an empty payload as a no-op apart from updatedAt', async () => {
    const before = await createContact();

    const res = await patch('contacts', before.id, {});

    expect(res.status).toBe(200);
    // Nothing may change except updatedAt, which has its own deterministic test.
    expect(stripMeta(res.body)).toEqual(stripMeta(before));
  });

  it('lets a field be cleared with an explicit empty value', async () => {
    await createContact({ phone: '555-0100' });
    const created = await createContact({ phone: '555-0100' });

    const res = await patch('contacts', created.id, { phone: '' });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('');
    expect(res.body.name).toBe(created.name);
  });

  it('still coerces numeric built-ins from strings', async () => {
    const created = await asOwner(request(app).post('/api/deals')).send({
      title: 'Analytical engine licence',
      company: 'Analytical Engines',
      value: 1000,
      stage: 'proposal',
    });
    expect(created.status).toBe(201);

    const res = await patch('deals', created.body.id, { value: '5000' });

    expect(res.body.value).toBe(5000);
    expect(res.body.title).toBe('Analytical engine licence');
  });

  it('marks a message as read without disturbing its other fields', async () => {
    const created = await asOwner(request(app).post('/api/messages')).send({
      threadId: 'thread_patch',
      body: 'Are we still on for Tuesday?',
      read: false,
      direction: 'in',
    });
    expect(created.status).toBe(201);

    // This is the exact call the frontend makes when opening a thread.
    const res = await patch('messages', created.body.id, { read: true });

    expect(res.status).toBe(200);
    expect(res.body.read).toBe(true);
    expect(res.body.body).toBe('Are we still on for Tuesday?');
    expect(res.body.threadId).toBe('thread_patch');
    expect(res.body.direction).toBe('in');
  });

  it('returns 404 for a record that does not exist', async () => {
    const res = await patch('contacts', 'contact_does_not_exist', { phone: '555-0199' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Record not found');
  });

  it('requires authentication', async () => {
    const created = await createContact();

    const res = await request(app)
      .patch(`/api/contacts/${created.id}`)
      .send({ phone: '555-0199' });

    expect(res.status).toBe(401);
  });

  it('rejects a role that is not allowed to edit', async () => {
    const created = await createContact();

    const res = await patch('contacts', created.id, { phone: '555-0199' }, viewerToken);

    expect(res.status).toBe(403);

    const stored = await getOne('contacts', created.id);
    expect(stored.body.phone).toBe('555-0100');
  });

  it('does not fall over for a resource it does not know', async () => {
    const res = await patch('notAResource', 'whatever', { phone: '555-0199' });

    expect(res.status).toBe(404);
  });

  it('records an audit entry for the update', async () => {
    const created = await createContact();
    const before = (await readDb()).audit.length;

    await patch('contacts', created.id, { phone: '555-0199' });

    const db = await readDb();
    expect(db.audit.length).toBe(before + 1);
    expect(db.audit[0].action).toBe('Updated contact');
  });

  it('returns a revisionId for the change', async () => {
    const created = await createContact();

    const res = await patch('contacts', created.id, { phone: '555-0199' });

    expect(res.body.revisionId).toBeTruthy();
  });
});

describe('PUT /api/:resource/:id keeps the same merge semantics', () => {
  it('still merges rather than replaces', async () => {
    const before = await createContact();

    const res = await asOwner(request(app).put(`/api/contacts/${before.id}`)).send({
      phone: '555-0199',
    });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('555-0199');
    expect(res.body.name).toBe(before.name);
    expect(res.body.email).toBe(before.email);
    expect(res.body.createdAt).toBe(before.createdAt);
  });

  it('now also refuses to rewind createdAt', async () => {
    const before = await createContact();

    const res = await asOwner(request(app).put(`/api/contacts/${before.id}`)).send({
      createdAt: '1999-01-01T00:00:00.000Z',
    });

    expect(res.status).toBe(200);
    expect(res.body.createdAt).toBe(before.createdAt);
  });

  it('still refuses to change the id', async () => {
    const before = await createContact();

    const res = await asOwner(request(app).put(`/api/contacts/${before.id}`)).send({
      id: 'hijacked_id',
    });

    expect(res.body.id).toBe(before.id);
  });
});
