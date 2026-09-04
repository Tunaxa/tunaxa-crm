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

// ============================================
// V1 Dynamic Object CRUD
// ============================================
describe('V1 Objects — CRUD', () => {
  let contactId;

  it('POST /api/v1/objects/contact creates a contact', async () => {
    const res = await request(app)
      .post('/api/v1/objects/contact')
      .set(auth())
      .send({ name: 'Alice Test', email: 'alice@test.com', status: 'New' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.object_type).toBe('contact');
    expect(res.body.properties.name).toBe('Alice Test');
    expect(res.body.properties.email).toBe('alice@test.com');
    contactId = res.body.id;
  });

  it('GET /api/v1/objects/contact/:id retrieves the contact', async () => {
    const res = await request(app).get(`/api/v1/objects/contact/${contactId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(contactId);
    expect(res.body.properties.name).toBe('Alice Test');
  });

  it('GET /api/v1/objects/contact/:id returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/v1/objects/contact/00000000-0000-0000-0000-000000000000').set(auth());
    expect(res.status).toBe(404);
  });

  it('PATCH /api/v1/objects/contact/:id updates properties', async () => {
    const res = await request(app)
      .patch(`/api/v1/objects/contact/${contactId}`)
      .set(auth())
      .send({ role: 'CEO', phone: '+1234567890' });
    expect(res.status).toBe(200);
    expect(res.body.properties.role).toBe('CEO');
    expect(res.body.properties.phone).toBe('+1234567890');
    expect(res.body.properties.name).toBe('Alice Test');
  });

  it('DELETE /api/v1/objects/contact/:id deletes the contact', async () => {
    const res = await request(app).delete(`/api/v1/objects/contact/${contactId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const check = await request(app).get(`/api/v1/objects/contact/${contactId}`).set(auth());
    expect(check.status).toBe(404);
  });

  it('POST returns 400 for empty body', async () => {
    const res = await request(app).post('/api/v1/objects/contact').set(auth()).send({});
    expect(res.status).toBe(400);
  });

  it('POST returns 400 for array body', async () => {
    const res = await request(app).post('/api/v1/objects/contact').set(auth()).send([1, 2]);
    expect(res.status).toBe(400);
  });
});

// ============================================
// V1 Schema
// ============================================
describe('V1 Objects — Schema', () => {
  it('GET /api/v1/objects/contact/schema returns property definitions', async () => {
    const res = await request(app).get('/api/v1/objects/contact/schema').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.object_type).toBe('contact');
    expect(Array.isArray(res.body.fields)).toBe(true);
    expect(res.body.fields.length).toBeGreaterThan(0);

    const nameField = res.body.fields.find(f => f.field_name === 'name');
    expect(nameField).toBeTruthy();
    expect(nameField.required).toBe(true);
  });

  it('GET /api/v1/objects/deal/schema returns deal definitions', async () => {
    const res = await request(app).get('/api/v1/objects/deal/schema').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.fields.some(f => f.field_name === 'stage')).toBe(true);
  });
});

// ============================================
// V1 List + Search
// ============================================
describe('V1 Objects — List & Search', () => {
  const ids = [];

  beforeAll(async () => {
    for (const [name, status] of [['Zoe Search', 'New'], ['Adam Search', 'Contacted'], ['Bob Search', 'New']]) {
      const res = await request(app)
        .post('/api/v1/objects/contact')
        .set(auth())
        .send({ name, email: `${name.toLowerCase().replace(' ', '.')}@test.com`, status });
      ids.push(res.body.id);
    }
  });

  afterAll(async () => {
    for (const id of ids) await request(app).delete(`/api/v1/objects/contact/${id}`).set(auth());
  });

  it('GET /api/v1/objects/contact lists contacts', async () => {
    const res = await request(app).get('/api/v1/objects/contact').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
  });

  it('GET /api/v1/objects/contact?q=Search searches', async () => {
    const res = await request(app).get('/api/v1/objects/contact?q=Search').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
  });

  it('GET /api/v1/objects/contact?status=New filters by property', async () => {
    const res = await request(app).get('/api/v1/objects/contact?status=New').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================
// V1 Associations
// ============================================
describe('V1 Associations', () => {
  let company, contact, deal;

  beforeAll(async () => {
    company = (await request(app).post('/api/v1/objects/company').set(auth()).send({ name: 'Acme Corp' })).body;
    contact = (await request(app).post('/api/v1/objects/contact').set(auth()).send({ name: 'John Doe' })).body;
    deal = (await request(app).post('/api/v1/objects/deal').set(auth()).send({ title: 'Big Deal', value: 50000 })).body;
  });

  afterAll(async () => {
    await request(app).delete(`/api/v1/objects/deal/${deal.id}`).set(auth());
    await request(app).delete(`/api/v1/objects/contact/${contact.id}`).set(auth());
    await request(app).delete(`/api/v1/objects/company/${company.id}`).set(auth());
  });

  it('POST /api/v1/associations creates a contact→company association', async () => {
    const res = await request(app)
      .post('/api/v1/associations')
      .set(auth())
      .send({ from_object_id: contact.id, to_object_id: company.id, association_type: 'contact_to_company', label: 'primary' });
    expect(res.status).toBe(201);
    expect(res.body.association_type).toBe('contact_to_company');
  });

  it('POST /api/v1/associations creates a deal→contact association', async () => {
    const res = await request(app)
      .post('/api/v1/associations')
      .set(auth())
      .send({ from_object_id: deal.id, to_object_id: contact.id, association_type: 'deal_to_contact' });
    expect(res.status).toBe(201);
  });

  it('GET /api/v1/objects/contact/:id/associations returns both directions', async () => {
    const res = await request(app).get(`/api/v1/objects/contact/${contact.id}/associations`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('GET /api/v1/associations/between?from=&to= returns specific', async () => {
    const res = await request(app).get(`/api/v1/associations/between?from=${deal.id}&to=${company.id}`).set(auth());
    expect(res.status).toBe(200);
  });

  it('DELETE /api/v1/associations removes an association', async () => {
    const res = await request(app)
      .delete('/api/v1/associations')
      .set(auth())
      .send({ from_object_id: contact.id, to_object_id: company.id, association_type: 'contact_to_company' });
    expect(res.status).toBe(200);

    const check = await request(app).get(`/api/v1/objects/contact/${contact.id}/associations`).set(auth());
    expect(check.body.total).toBe(1);
  });

  it('POST returns 400 for missing fields', async () => {
    const res = await request(app).post('/api/v1/associations').set(auth()).send({});
    expect(res.status).toBe(400);
  });
});

// ============================================
// V1 Batch
// ============================================
describe('V1 Batch', () => {
  const ids = [];

  afterAll(async () => {
    for (const id of ids) await request(app).delete(`/api/v1/objects/contact/${id}`).set(auth());
  });

  it('POST /api/v1/objects/contact/batch/create creates multiple', async () => {
    const res = await request(app)
      .post('/api/v1/objects/contact/batch/create')
      .set(auth())
      .send([{ name: 'Batch Alice' }, { name: 'Batch Bob' }, { name: 'Batch Carol' }]);
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(3);
    expect(res.body.data.length).toBe(3);
    ids.push(...res.body.data.map(d => d.id));
  });

  it('POST /api/v1/objects/contact/batch/update updates multiple', async () => {
    const res = await request(app)
      .post('/api/v1/objects/contact/batch/update')
      .set(auth())
      .send([{ id: ids[0], role: 'Manager' }, { id: ids[1], role: 'Engineer' }]);
    expect(res.status).toBe(201);
    expect(res.body.updated).toBe(2);

    const check = await request(app).get(`/api/v1/objects/contact/${ids[0]}`).set(auth());
    expect(check.body.properties.role).toBe('Manager');
  });

  it('POST /api/v1/objects/contact/batch/create returns 400 for array body items', async () => {
    const res = await request(app)
      .post('/api/v1/objects/contact/batch/create')
      .set(auth())
      .send([123]);
    expect(res.status).toBe(400);
  });

  it('POST /api/v1/objects/contact/batch/create returns 400 for >100 items', async () => {
    const res = await request(app)
      .post('/api/v1/objects/contact/batch/create')
      .set(auth())
      .send(new Array(101).fill({ name: 'X' }));
    expect(res.status).toBe(400);
  });

  it('POST /api/v1/objects/contact/batch/update returns 400 if no id', async () => {
    const res = await request(app)
      .post('/api/v1/objects/contact/batch/update')
      .set(auth())
      .send([{ name: 'No ID' }]);
    expect(res.status).toBe(400);
  });

  it('POST /api/v1/objects/contact/batch/create returns 400 for empty array', async () => {
    const res = await request(app)
      .post('/api/v1/objects/contact/batch/create')
      .set(auth())
      .send([]);
    expect(res.status).toBe(400);
  });
});

// ============================================
// V1 Cursor Sync
// ============================================
describe('V1 Sync', () => {
  it('GET /api/v1/objects/contact/sync returns 400 without cursor', async () => {
    const res = await request(app).get('/api/v1/objects/contact/sync').set(auth());
    expect(res.status).toBe(400);
  });

  it('GET /api/v1/objects/contact/sync?cursor=... returns paginated results', async () => {
    const res = await request(app).get(`/api/v1/objects/contact/sync?cursor=${encodeURIComponent(new Date(0).toISOString())}&limit=2`).set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.has_more).toBe('boolean');
    expect(typeof res.body.cursor).toBe('string');
  });
});

// ============================================
// V1 Validation
// ============================================
describe('V1 Validation', () => {
  it('POST /api/v1/objects/contact rejects invalid enum', async () => {
    const res = await request(app)
      .post('/api/v1/objects/contact')
      .set(auth())
      .send({ name: 'Bad Status', status: 'InvalidStatus' });
    expect(res.status).toBe(400);
    expect(res.body.details).toBeTruthy();
  });

  it('POST /api/v1/objects/contact accepts valid enum', async () => {
    const res = await request(app)
      .post('/api/v1/objects/contact')
      .set(auth())
      .send({ name: 'Good Contact', status: 'Qualified' });
    expect(res.status).toBe(201);
    await request(app).delete(`/api/v1/objects/contact/${res.body.id}`).set(auth());
  });

  it('PATCH /api/v1/objects/contact/:id partial validation works', async () => {
    const c = (await request(app).post('/api/v1/objects/contact').set(auth()).send({ name: 'Partial Test' })).body;
    const res = await request(app).patch(`/api/v1/objects/contact/${c.id}`).set(auth()).send({ role: 'VP' });
    expect(res.status).toBe(200);
    await request(app).delete(`/api/v1/objects/contact/${c.id}`).set(auth());
  });
});

// ============================================
// V1 Auth — verify 401 without token
// ============================================
describe('V1 Auth — 401 without token', () => {
  it('GET /api/v1/objects/contact returns 401 without token', async () => {
    const res = await request(app).get('/api/v1/objects/contact');
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/objects/contact returns 401 without token', async () => {
    const res = await request(app).post('/api/v1/objects/contact').send({ name: 'X' });
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/webhooks returns 401 without token', async () => {
    const res = await request(app).get('/api/v1/webhooks');
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/associations returns 401 without token', async () => {
    const res = await request(app).post('/api/v1/associations').send({});
    expect(res.status).toBe(401);
  });
});

// ============================================
// V1 Webhooks
// ============================================
describe('V1 Webhooks', () => {
  let webhookId;

  it('POST /api/v1/webhooks creates a subscription', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks')
      .set(auth())
      .send({ url: 'https://example.com/hook', events: ['contact.created'] });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.secret).toBeTruthy();
    expect(res.body.events).toContain('contact.created');
    webhookId = res.body.id;
  });

  it('POST /api/v1/webhooks rejects invalid URL', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks')
      .set(auth())
      .send({ url: 'not-a-url', events: ['test'] });
    expect(res.status).toBe(400);
  });

  it('POST /api/v1/webhooks rejects missing events', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks')
      .set(auth())
      .send({ url: 'https://example.com/hook' });
    expect(res.status).toBe(400);
  });

  it('GET /api/v1/webhooks lists subscriptions', async () => {
    const res = await request(app).get('/api/v1/webhooks').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/v1/webhooks/:id gets a subscription', async () => {
    const res = await request(app).get(`/api/v1/webhooks/${webhookId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(webhookId);
  });

  it('PATCH /api/v1/webhooks/:id updates subscription', async () => {
    const res = await request(app)
      .patch(`/api/v1/webhooks/${webhookId}`)
      .set(auth())
      .send({ events: ['contact.created', 'contact.updated'] });
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBe(2);
  });

  it('DELETE /api/v1/webhooks/:id deletes subscription', async () => {
    const res = await request(app).delete(`/api/v1/webhooks/${webhookId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const check = await request(app).get(`/api/v1/webhooks/${webhookId}`).set(auth());
    expect(check.status).toBe(404);
  });

  it('GET /api/v1/webhooks/events lists event log', async () => {
    const res = await request(app).get('/api/v1/webhooks/events').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /api/v1/webhooks/events?status=completed filters', async () => {
    const res = await request(app).get('/api/v1/webhooks/events?status=completed').set(auth());
    expect(res.status).toBe(200);
  });
});
