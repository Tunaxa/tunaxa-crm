import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';

let app;
let token;

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
});

afterAll(() => cleanupTestDb());

describe('Generic CRUD - leads', () => {
  let leadId;

  it('POST /api/leads creates a lead', async () => {
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Acme Corp', email: 'info@acme.com', phone: '+1234567890', status: 'New' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('Acme Corp');
    expect(res.body.createdAt).toBeTruthy();
    leadId = res.body.id;
  });

  it('GET /api/leads lists leads', async () => {
    const res = await request(app).get('/api/leads').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/leads?q=Acme filters', async () => {
    const res = await request(app).get('/api/leads?q=Acme').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Acme Corp');
  });

  it('GET /api/leads paginates and sorts', async () => {
    const res = await request(app)
      .get('/api/leads?page=1&limit=1&sortBy=name&sortDir=asc')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('GET /api/leads/export.csv streams a CSV', async () => {
    const res = await request(app)
      .get('/api/leads/export.csv')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('name');
    expect(res.text).toContain('Acme Corp');
  });

  it('GET /api/leads/export.csv downloads all leads as CSV', async () => {
    const res = await request(app)
      .get('/api/leads/export.csv')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('leads.csv');
    expect(res.text).toContain('"name"');
    expect(res.text).toContain('"Acme Corp"');
  });

  it('GET /api/leads/export.csv requires authentication', async () => {
    const res = await request(app).get('/api/leads/export.csv');
    expect(res.status).toBe(401);
  });

  it('PUT /api/leads/:id updates lead', async () => {
    const res = await request(app)
      .put(`/api/leads/${leadId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'Qualified', value: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Qualified');
    expect(res.body.value).toBe(5000);
  });

  it('DELETE /api/leads/:id removes lead', async () => {
    const res = await request(app).delete(`/api/leads/${leadId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const list = await request(app).get('/api/leads').set('Authorization', `Bearer ${token}`);
    expect(list.body.find(x => x.id === leadId)).toBeUndefined();
  });

  it('PUT /api/leads/:id returns 404 for missing', async () => {
    const res = await request(app)
      .put('/api/leads/lead_nonexistent')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/leads/:id returns 404 for missing', async () => {
    const res = await request(app).delete('/api/leads/lead_nonexistent').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('CSV export', () => {
  it.each(['contacts', 'companies'])('exports %s with quoted CSV values', async (resource) => {
    const name = 'North, "Division"';
    const created = await request(app)
      .post(`/api/${resource}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name });
    expect(created.status).toBe(201);

    const res = await request(app)
      .get(`/api/${resource}/export.csv`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('"North, ""Division"""');
  });
});

describe('Activity timeline filters', () => {
  it('filters by record and selected activity type', async () => {
    const contact = 'AXA-97 Filter Target';
    for (const type of ['Email', 'Call', 'Meeting', 'Note', 'Lifecycle']) {
      const created = await request(app)
        .post('/api/activities')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: `${type} event`, type, contact });
      expect(created.status).toBe(201);
    }
    const unrelated = await request(app)
      .post('/api/activities')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Other email', type: 'Email', contact: 'Someone Else' });
    expect(unrelated.status).toBe(201);

    const email = await request(app)
      .get('/api/activities')
      .query({ contact, type: 'Email' })
      .set('Authorization', `Bearer ${token}`);
    expect(email.status).toBe(200);
    expect(email.body.map((item) => item.title)).toEqual(['Email event']);

    const system = await request(app)
      .get('/api/activities')
      .query({ contact, type: 'System' })
      .set('Authorization', `Bearer ${token}`);
    expect(system.status).toBe(200);
    expect(system.body.map((item) => item.title)).toEqual(['Lifecycle event']);

    const all = await request(app)
      .get('/api/activities')
      .query({ contact })
      .set('Authorization', `Bearer ${token}`);
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(5);
  });
});

describe('Batch import', () => {
  it('POST /api/leads/batch creates multiple', async () => {
    const res = await request(app)
      .post('/api/leads/batch')
      .set('Authorization', `Bearer ${token}`)
      .send([
        { name: 'Batch A', email: 'a@test.com' },
        { name: 'Batch B', email: 'b@test.com' }
      ]);
    expect(res.status).toBe(201);
    expect(res.body.length).toBe(2);
  });

  it('POST /api/leads/batch rejects empty array', async () => {
    const res = await request(app)
      .post('/api/leads/batch')
      .set('Authorization', `Bearer ${token}`)
      .send([]);
    expect(res.status).toBe(400);
  });

  it('POST /api/leads/batch rejects object', async () => {
    const res = await request(app)
      .post('/api/leads/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Not array' });
    expect(res.status).toBe(400);
  });
});

describe('Numeric coercion', () => {
  it('POST /api/deals coerces value string to number', async () => {
    const res = await request(app)
      .post('/api/deals')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Big Deal', value: '12345.50', stage: 'new' });
    expect(res.status).toBe(201);
    expect(res.body.value).toBe(12345.5);
  });
});

describe('Unauthorized access', () => {
  it('GET /api/leads without token returns 401', async () => {
    const res = await request(app).get('/api/leads');
    expect(res.status).toBe(401);
  });

  it('POST /api/leads without token returns 401', async () => {
    const res = await request(app).post('/api/leads').send({ name: 'X' });
    expect(res.status).toBe(401);
  });

  it('Unknown resource returns 404', async () => {
    const res = await request(app)
      .get('/api/unknownresource')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
