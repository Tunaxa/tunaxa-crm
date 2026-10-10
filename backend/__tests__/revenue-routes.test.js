import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import { query } from '../db/pg.js';

const REVENUE = ['quotes', 'invoices', 'products', 'orders', 'contracts', 'expenses'];

// Only a resource that actually reached Postgres proves the routing. Sending an
// email that belongs to no record must come back empty rather than falling
// through to whatever the JSON store happens to hold.
const CUSTOMER_EMAIL = 'buyer@acme.test';

let app;
let token;

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
}, 30000);

afterAll(() => cleanupTestDb());

const auth = (req) => req.set('Authorization', `Bearer ${token}`);

describe('Customer portal reads Postgres', () => {
  it('POST /api/portal/access returns 400 when email is missing', async () => {
    const res = await request(app).post('/api/portal/access').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('returns quotes and contracts written to Postgres for a matching email', async () => {
    // `customerEmail` is not a column: legacyToPg() files it under
    // custom_fields, and pgToLegacy() flattens the bag back to the top level.
    // That round trip is what lets the portal's emailEquals() see it.
    const quote = await auth(request(app).post('/api/quotes')).send({
      title: 'Acme Platform Licence',
      customerEmail: CUSTOMER_EMAIL,
      total: 4200,
    });
    expect(quote.status).toBe(201);

    const contract = await auth(request(app).post('/api/contracts')).send({
      title: 'Acme Master Services',
      customerEmail: CUSTOMER_EMAIL,
    });
    expect(contract.status).toBe(201);

    const invoice = await auth(request(app).post('/api/invoices')).send({
      customerEmail: CUSTOMER_EMAIL,
      amount: 4200,
    });
    expect(invoice.status).toBe(201);

    // The portal endpoint is unauthenticated by design: it is the customer
    // facing lookup keyed on an email plus the rate limiter.
    const res = await request(app)
      .post('/api/portal/access')
      .send({ email: CUSTOMER_EMAIL });

    expect(res.status).toBe(200);
    expect(res.body.quotes.map((r) => r.id)).toContain(quote.body.id);
    expect(res.body.contracts.map((r) => r.id)).toContain(contract.body.id);
    expect(res.body.invoices.map((r) => r.id)).toContain(invoice.body.id);
    // The record keeps the legacy key name rather than a nested bag.
    expect(res.body.quotes[0].customerEmail).toBe(CUSTOMER_EMAIL);
  });

  it('returns empty lists for an email with no records', async () => {
    const res = await request(app)
      .post('/api/portal/access')
      .send({ email: 'nobody@nowhere.test' });
    expect(res.status).toBe(200);
    expect(res.body.quotes).toEqual([]);
    expect(res.body.contracts).toEqual([]);
    expect(res.body.invoices).toEqual([]);
  });
});

describe('Revenue 404 handling', () => {
  it.each(REVENUE)('GET /api/%s/:id returns 404 for a missing id', async (resource) => {
    const res = await auth(request(app).get(`/api/${resource}/pg_missing_id`));
    expect(res.status).toBe(404);
  });

  it.each(REVENUE)('PUT /api/%s/:id returns 404 for a missing id', async (resource) => {
    const res = await auth(request(app).put(`/api/${resource}/pg_missing_id`)).send({ title: 'X' });
    expect(res.status).toBe(404);
  });

  it.each(REVENUE)('DELETE /api/%s/:id returns 404 for a missing id', async (resource) => {
    const res = await auth(request(app).delete(`/api/${resource}/pg_missing_id`));
    expect(res.status).toBe(404);
  });
});

describe('Revenue write round trips', () => {
  it.each(['quotes', 'contracts', 'orders', 'invoices', 'expenses'])(
    'PUT then DELETE /api/%s/:id persists and removes the record',
    async (resource) => {
      const created = await auth(request(app).post(`/api/${resource}`)).send({
        title: `Round trip ${resource}`,
        name: `Round trip ${resource}`,
        amount: 10,
      });
      expect(created.status).toBe(201);
      const { id } = created.body;
      expect(id).toBeTruthy();

      const updated = await auth(request(app).put(`/api/${resource}/${id}`)).send({
        title: `Renamed ${resource}`,
        amount: 99,
      });
      expect(updated.status).toBe(200);
      expect(updated.body.id).toBe(id);

      const removed = await auth(request(app).delete(`/api/${resource}/${id}`));
      expect(removed.status).toBe(200);

      const after = await auth(request(app).get(`/api/${resource}/${id}`));
      expect(after.status).toBe(404);
    },
  );
});

describe('Category filter reaches the repository', () => {
  it('filters products by category', async () => {
    const hardware = await auth(request(app).post('/api/products')).send({
      name: 'Widget A',
      category: 'Hardware',
      price: 10,
    });
    const software = await auth(request(app).post('/api/products')).send({
      name: 'Widget B',
      category: 'Software',
      price: 20,
    });
    expect(hardware.status).toBe(201);
    expect(software.status).toBe(201);

    const res = await auth(request(app).get('/api/products?category=Hardware'));
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.id)).toContain(hardware.body.id);
    expect(res.body.map((r) => r.id)).not.toContain(software.body.id);
  });

  it('filters expenses by category', async () => {
    const hosting = await auth(request(app).post('/api/expenses')).send({
      title: 'Hosting bill',
      vendor: 'Acme Hosting',
      category: 'Software',
      amount: 200,
    });
    const travel = await auth(request(app).post('/api/expenses')).send({
      title: 'Taxi',
      vendor: 'City Cabs',
      category: 'Travel',
      amount: 40,
    });
    expect(hosting.status).toBe(201);
    expect(travel.status).toBe(201);

    const res = await auth(request(app).get('/api/expenses?category=Travel'));
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.id)).toContain(travel.body.id);
    expect(res.body.map((r) => r.id)).not.toContain(hosting.body.id);
  });
});

describe('Pagination is clamped', () => {
  it('caps a page at 100 rows even when a larger limit is requested', async () => {
    // Bulk insert so the assertion is about the clamp rather than about how
    // many records the earlier tests happened to create.
    const values = Array.from(
      { length: 105 },
      (_, i) => `('pg_clamp_${i}', 'default', 'Clamp ${i}', 'CLAMP')`,
    ).join(',');
    await query(
      `INSERT INTO products (id, workspace_id, name, sku) VALUES ${values}`,
    );

    const res = await auth(request(app).get('/api/products?limit=1000'));
    expect(res.status).toBe(200);
    // A bare array means pgFindAll() took the single-page branch.
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(100);
  });
});

describe('Revenue CSV export', () => {
  it.each(['quotes', 'invoices', 'products', 'orders', 'contracts', 'expenses'])(
    'exports %s as CSV',
    async (resource) => {
      const res = await auth(request(app).get(`/api/${resource}/export.csv`));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain(`${resource}.csv`);
    },
  );
});
