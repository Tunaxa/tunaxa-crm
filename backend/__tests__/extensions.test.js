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
    expect(group.records).toHaveLength(2);
    expect(group.confidence).toBe(100);
    expect(group.score).toBe(1);
    expect(group.matches).toHaveLength(1);
    expect(group.matches[0].score).toBe(1);
    expect(group.matches[0].rawScore).toBe(0);

    const merge = await request(app).post('/api/duplicates/merge').set('Authorization', `Bearer ${token}`).send({ resource: 'contacts', keepId: group.ids[0], mergeId: group.ids[1] });
    expect(merge.status).toBe(200);
    expect(merge.body.phone).toBe('+123');

    const list = await request(app).get('/api/contacts').set('Authorization', `Bearer ${token}`);
    expect(list.body.filter(c => c.email === 'jane@test.com').length).toBe(1);
  });

  it('groups fuzzy company name matches', async () => {
    await request(app).post('/api/companies').set('Authorization', `Bearer ${token}`).send({ name: 'Acme Corporation' });
    await request(app).post('/api/companies').set('Authorization', `Bearer ${token}`).send({ name: 'Acme Corporaton' });

    const find = await request(app).get('/api/duplicates?resource=companies').set('Authorization', `Bearer ${token}`);
    const group = find.body.duplicates.find(g => g.names.includes('Acme Corporation'));
    expect(group).toBeTruthy();
  });

  it('detects fuzzy-near-match duplicates for companies and scores them below 1', async () => {
    await request(app).post('/api/companies').set('Authorization', `Bearer ${token}`).send({ name: 'Phil Schmitz' });
    await request(app).post('/api/companies').set('Authorization', `Bearer ${token}`).send({ name: 'Philip Schmitz' });

    const find = await request(app).get('/api/duplicates?resource=companies').set('Authorization', `Bearer ${token}`);
    expect(find.status).toBe(200);
    const group = find.body.duplicates.find(g => g.names.includes('Phil Schmitz'));
    expect(group).toBeTruthy();
    expect(group.ids.length).toBe(2);
    expect(group.score).toBeGreaterThan(0);
    expect(group.score).toBeLessThan(1);
    expect(group.matches).toHaveLength(1);
    expect(group.matches[0].score).toBe(group.score);
  });

  it('does not flag contacts sharing only an email domain (different local parts)', async () => {
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'Exact Test', email: 'exact.test@example.com' });
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'Dupe Test', email: 'dupe.test@example.com' });

    const find = await request(app).get('/api/duplicates?resource=contacts').set('Authorization', `Bearer ${token}`);
    expect(find.status).toBe(200);
    expect(find.body.duplicates.find(g => g.names.includes('Dupe Test'))).toBeUndefined();
    expect(find.body.total).toBe(0);
  });

  it('scores each duplicate member against the primary record it would merge into', async () => {
    // New records are unshifted onto the front of the list, and the first row
    // in the list is the primary/kept record. Create the Phils first so the
    // typo'd "Philp Schmitz" ends up as the primary, matching the manual-test
    // scenario.
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'Phil Schmitz', email: 'phil.schmitz@soylent.co' });
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'Phil Schmitz', email: 'phil.schmitz@acme.com' });
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'Philp Schmitz', email: 'philp.schmitz@acme.com' });

    const find = await request(app).get('/api/duplicates?resource=contacts').set('Authorization', `Bearer ${token}`);
    const group = find.body.duplicates.find(g => g.names[0] === 'Philp Schmitz');
    expect(group).toBeTruthy();
    expect(group.ids.length).toBe(3);
    // Each member is scored against the primary "Philp Schmitz", which differs
    // from "Phil Schmitz" by one character, so neither member may be reported
    // at full confidence even though the two "Phil Schmitz" records match each
    // other exactly.
    expect(group.matches).toHaveLength(2);
    expect(group.matches.every(m => m.score > 0 && m.score < 1)).toBe(true);
    expect(group.matches.every(m => m.rawScore > 0 && m.rawScore <= 0.2)).toBe(true);
  });

  it('does not group contacts whose email local parts merely overlap by substring (alice vs alice.miller)', async () => {
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'Alice', email: 'alice@example.com' });
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'Alice Miller', email: 'alice.miller@example.com' });

    const find = await request(app).get('/api/duplicates?resource=contacts').set('Authorization', `Bearer ${token}`);
    expect(find.status).toBe(200);
    expect(find.body.duplicates.find(g => g.names.includes('Alice Miller'))).toBeUndefined();
  });

  it('does not fuzzy-match very short email local parts', async () => {
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'Abe', email: 'ab@example.com' });
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'Acc', email: 'ac@example.com' });

    const find = await request(app).get('/api/duplicates?resource=contacts').set('Authorization', `Bearer ${token}`);
    expect(find.body.duplicates.find(g => g.names.includes('Acc'))).toBeUndefined();
  });
});

describe('Customer portal', () => {
  it('returns customer-facing records for a matching email', async () => {
    // Seeded through the API rather than pushed into db.json: quotes,
    // contracts and invoices are served from Postgres, and the portal reads the
    // same repositories the write path uses. Rows written straight into the
    // JSON store are invisible to it, which is exactly the split-store bug
    // this endpoint used to have.
    const quote = await request(app).post('/api/quotes').set('Authorization', `Bearer ${token}`).send({ title: 'Q-P deal', customerEmail: 'cust@acme.com', total: 1500, status: 'Sent' });
    const contract = await request(app).post('/api/contracts').set('Authorization', `Bearer ${token}`).send({ title: 'Acme deal', customerEmail: 'cust@acme.com', status: 'Active' });
    const invoice = await request(app).post('/api/invoices').set('Authorization', `Bearer ${token}`).send({ customerEmail: 'cust@acme.com', amount: 700, status: 'Paid' });
    expect(quote.status).toBe(201);
    expect(contract.status).toBe(201);
    expect(invoice.status).toBe(201);

    const res = await request(app).post('/api/portal/access').send({ email: 'cust@ACME.com' });
    expect(res.status).toBe(200);
    expect(res.body.customer.email).toBe('cust@acme.com');
    expect(res.body.quotes.some(q => q.id === quote.body.id)).toBe(true);
    expect(res.body.contracts.some(c => c.id === contract.body.id)).toBe(true);
    expect(res.body.invoices.some(i => i.id === invoice.body.id)).toBe(true);
  });

  it('requires an email', async () => {
    const res = await request(app).post('/api/portal/access').send({});
    expect(res.status).toBe(400);
  });
});
