import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import { seedPlaybooks } from '../services/seedPlaybooks.js';
import { mutateDb } from '../store.js';

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

describe('Webhook endpoints (Automation)', () => {
  let endpointId;
  let url;

  it('creates a webhook endpoint with a unique hook URL', async () => {
    const res = await request(app).post('/api/webhookEndpoints').set('Authorization', `Bearer ${token}`).send({ name: 'Slack alerts' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.token).toMatch(/^whk_/);
    expect(res.body.url).toContain('/api/hooks/');
    endpointId = res.body.id;
    url = res.body.url;
  });

  it('rejects a webhook endpoint without a name', async () => {
    const res = await request(app).post('/api/webhookEndpoints').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });

  it('lists webhook endpoints (auth required)', async () => {
    const res = await request(app).get('/api/webhookEndpoints').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects public hook delivery for an unknown token', async () => {
    const res = await request(app).post('/api/hooks/whk_doesnotexist').send({ hello: 'world' });
    expect(res.status).toBe(404);
  });

  it('accepts a public delivery, records it, and returns ok', async () => {
    const res = await request(app).post('/api/hooks/' + url.split('/api/hooks/')[1]).send({ hello: 'world', email: 'lead@acme.com' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deliveryId).toBeTruthy();

    const deliveries = await request(app).get('/api/webhookDeliveries').set('Authorization', `Bearer ${token}`);
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.data.some(d => d.payload?.hello === 'world')).toBe(true);
  });

  it('increments requestCount on the endpoint', async () => {
    const res = await request(app).get('/api/webhookEndpoints').set('Authorization', `Bearer ${token}`);
    const ep = res.body.data.find(e => e.id === endpointId);
    expect(ep.requestCount).toBeGreaterThanOrEqual(1);
  });

  it('returns recent deliveries for a specific endpoint', async () => {
    const res = await request(app).get(`/api/webhookEndpoints/${endpointId}/deliveries`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.every(d => d.endpointId === endpointId)).toBe(true);
    expect(res.body.data.some(d => d.payload?.hello === 'world')).toBe(true);
    expect(res.body.data[0].status).toBe('received');
    expect(res.body.data[0].attemptNumber).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].contentType).toContain('json');
  });

  it('numbers delivery attempts per endpoint in order', async () => {
    const before = await request(app).get(`/api/webhookEndpoints/${endpointId}/deliveries`).set('Authorization', `Bearer ${token}`);
    const count = before.body.data.length;
    const hit = await request(app).post('/api/hooks/' + url.split('/api/hooks/')[1]).send({ hello: 'numbered' });
    expect(hit.status).toBe(200);
    const after = await request(app).get(`/api/webhookEndpoints/${endpointId}/deliveries`).set('Authorization', `Bearer ${token}`);
    expect(after.body.data[0].attemptNumber).toBe(count + 1);
  });

  it('rejects deliveries listing without auth and for unknown endpoints', async () => {
    const unauth = await request(app).get(`/api/webhookEndpoints/${endpointId}/deliveries`);
    expect(unauth.status).toBe(401);
    const missing = await request(app).get('/api/webhookEndpoints/whk_missing/deliveries').set('Authorization', `Bearer ${token}`);
    expect(missing.status).toBe(404);
  });

  it('registers webhook.received as a workflow trigger', async () => {
    const res = await request(app).get('/api/workflows/meta').set('Authorization', `Bearer ${token}`);
    expect(res.body.events.some(e => e.value === 'webhook.received')).toBe(true);
  });

  it('deletes a webhook endpoint', async () => {
    const res = await request(app).delete(`/api/webhookEndpoints/${endpointId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('seeds a webhook.received playbook', async () => {
    await seedPlaybooks();
    const res = await request(app).get('/api/workflows').set('Authorization', `Bearer ${token}`);
    expect(res.body.data.some(w => w.event === 'webhook.received')).toBe(true);
  });
});

describe('Forms management (Marketing > Forms)', () => {
  let formId;
  let permalink;

  it('creates a form with fields', async () => {
    const res = await request(app).post('/api/forms').set('Authorization', `Bearer ${token}`).send({
      name: 'Demo request',
      submitTo: 'lead',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'email', label: 'Email', type: 'text', required: true },
        { key: 'interest', label: 'Interest', type: 'select', options: ['A', 'B'] }
      ]
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.permalink).toBeTruthy();
    expect(res.body.fields.length).toBe(3);
    formId = res.body.id;
    permalink = res.body.permalink;
  });

  it('rejects a form without fields', async () => {
    const res = await request(app).post('/api/forms').set('Authorization', `Bearer ${token}`).send({ name: 'Broken' });
    expect(res.status).toBe(400);
  });

  it('exposes the form publicly and accepts a submission that creates a lead', async () => {
    const view = await request(app).get(`/api/forms/${permalink}`);
    expect(view.status).toBe(200);
    expect(view.body.form.permalink).toBe(permalink);

    const submit = await request(app).post(`/api/forms/${permalink}/submit`).send({ name: 'Jane', email: 'jane@demo.com', interest: 'A' });
    expect(submit.status).toBe(201);
    expect(submit.body.recordId).toBeTruthy();

    const leads = await request(app).get('/api/leads').set('Authorization', `Bearer ${token}`);
    expect(leads.body.data.some(l => l.email === 'jane@demo.com')).toBe(true);
  });

  it('rejects a submission missing required fields', async () => {
    const res = await request(app).post(`/api/forms/${permalink}/submit`).send({ name: 'No email' });
    expect(res.status).toBe(400);
  });

  it('lists and deletes forms', async () => {
    const list = await request(app).get('/api/forms').set('Authorization', `Bearer ${token}`);
    expect(list.body.total).toBeGreaterThanOrEqual(1);

    const del = await request(app).delete(`/api/forms/${formId}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
  });
});

describe('Webhook-triggered workflow execution', () => {
  it('runs a workflow action for a webhook.received event', async () => {
    await seedPlaybooks();
    const created = await request(app).post('/api/workflows').set('Authorization', `Bearer ${token}`).send({
      name: 'Webhook test flow',
      event: 'webhook.received',
      enabled: true,
      actions: [{ type: 'activity', title: 'Got webhook', subtype: 'Webhook', notes: '{{endpoint.name}}' }]
    });
    expect(created.status).toBe(201);

    await mutateDb(db => {
      db.webhookEndpoints.push({
        id: 'webhook_test_ep', token: 'whk_test_endpoint', name: 'Test endpoint',
        enabled: true, requestCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
    });

    const hit = await request(app).post('/api/hooks/whk_test_endpoint').send({ foo: 'bar' });
    expect(hit.status).toBe(200);

    const activities = await request(app).get('/api/activities').set('Authorization', `Bearer ${token}`);
    expect(activities.body.data.some(a => a.title === 'Got webhook')).toBe(true);
  });
});
