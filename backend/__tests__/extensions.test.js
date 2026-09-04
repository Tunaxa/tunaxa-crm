import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
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

function crud(resource, singular, payload) {
  describe(`Generic CRUD - ${resource}`, () => {
    let id;
    it('POST creates a record', async () => {
      const res = await request(app).post(`/api/${resource}`).set('Authorization', `Bearer ${token}`).send(payload);
      expect(res.status).toBe(201);
      expect(res.body.id).toBeTruthy();
      id = res.body.id;
    });
    it('GET lists records', async () => {
      const res = await request(app).get(`/api/${resource}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
    it('PUT updates a record', async () => {
      const res = await request(app).put(`/api/${resource}/${id}`).set('Authorization', `Bearer ${token}`).send({ status: payload.status === 'Draft' || payload.status === 'Planned' ? (payload.status === 'Planned' ? 'Completed' : 'Sent') : 'Active' });
      expect(res.status).toBe(200);
    });
    it('DELETE removes a record', async () => {
      const res = await request(app).delete(`/api/${resource}/${id}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });
}

crud('quotes', 'quote', { number: 'Q-100', customer: 'Acme', total: 1000, status: 'Draft' });
crud('contracts', 'contract', { name: 'Annual plan', customer: 'Acme', value: 12000, mrr: 1000, billingFrequency: 'Monthly', status: 'Active' });
crud('marketingEmails', 'marketing email', { name: 'Newsletter', subject: 'Hi', status: 'Draft' });
crud('marketingEvents', 'event', { name: 'Webinar', type: 'Webinar', capacity: 100, status: 'Planned' });
crud('goals', 'goal', { name: 'Q3 revenue', metric: 'Revenue', target: 50000, period: 'Quarterly' });
crud('surveys', 'survey', { name: 'NPS', type: 'NPS', status: 'Draft' });
crud('surveyResponses', 'survey response', { survey: 'NPS', respondent: 'a@b.com', score: 9 });

describe('Numeric coercion for new resources', () => {
  it('coerces quote total, contract value/mrr, event numbers, goal target, survey score to numbers', async () => {
    const quote = await request(app).post('/api/quotes').set('Authorization', `Bearer ${token}`).send({ number: 'Q-NUM', total: '2499.50', discount: '0' });
    expect(quote.body.total).toBe(2499.5);
    const contract = await request(app).post('/api/contracts').set('Authorization', `Bearer ${token}`).send({ name: 'NUM', value: '5000', mrr: '415' });
    expect(contract.body.value).toBe(5000);
    expect(contract.body.mrr).toBe(415);
    const event = await request(app).post('/api/marketingEvents').set('Authorization', `Bearer ${token}`).send({ name: 'NUM', capacity: '50', registrations: '12' });
    expect(event.body.capacity).toBe(50);
    const goal = await request(app).post('/api/goals').set('Authorization', `Bearer ${token}`).send({ name: 'NUM', target: '100', current: '40' });
    expect(goal.body.target).toBe(100);
    const response = await request(app).post('/api/surveyResponses').set('Authorization', `Bearer ${token}`).send({ survey: 'NPS', score: '9' });
    expect(response.body.score).toBe(9);
  });
});

describe('Duplicate management', () => {
  it('detects duplicate contacts by email and merges them', async () => {
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'Jane Doe', email: 'jane@test.com' });
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'Jane D.', email: 'jane@test.com', phone: '+123' });

    const find = await request(app).get('/api/duplicates?resource=contacts').set('Authorization', `Bearer ${token}`);
    expect(find.status).toBe(200);
    const group = find.body.duplicates.find(g => g.names.includes('Jane Doe'));
    expect(group).toBeTruthy();
    expect(group.ids.length).toBe(2);

    const merge = await request(app).post('/api/duplicates/merge').set('Authorization', `Bearer ${token}`).send({ resource: 'contacts', keepId: group.ids[0], mergeId: group.ids[1] });
    expect(merge.status).toBe(200);
    expect(merge.body.phone).toBe('+123');

    const list = await request(app).get('/api/contacts').set('Authorization', `Bearer ${token}`);
    expect(list.body.filter(c => c.email === 'jane@test.com').length).toBe(1);
  });
});

describe('Customer portal', () => {
  it('returns customer-facing records for a matching email', async () => {
    await mutateDb(db => {
      db.quotes.push({ id: 'quote_portal', number: 'Q-P', customerEmail: 'cust@acme.com', total: 1500, status: 'Sent', createdAt: new Date().toISOString() });
      db.contracts.push({ id: 'contract_portal', name: 'Acme deal', customerEmail: 'cust@acme.com', status: 'Active', createdAt: new Date().toISOString() });
      db.invoices.push({ id: 'inv_portal', number: 'INV-P', customerEmail: 'cust@acme.com', amount: 700, status: 'Paid', createdAt: new Date().toISOString() });
    });

    const res = await request(app).post('/api/portal/access').send({ email: 'cust@ACME.com' });
    expect(res.status).toBe(200);
    expect(res.body.customer.email).toBe('cust@acme.com');
    expect(res.body.quotes.some(q => q.id === 'quote_portal')).toBe(true);
    expect(res.body.contracts.some(c => c.id === 'contract_portal')).toBe(true);
    expect(res.body.invoices.some(i => i.id === 'inv_portal')).toBe(true);
  });

  it('requires an email', async () => {
    const res = await request(app).post('/api/portal/access').send({});
    expect(res.status).toBe(400);
  });
});
