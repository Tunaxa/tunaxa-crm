import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import { renderQuotePdfBuffer, renderQuotePdfStream } from '../services/quotePdf.js';
import { repoFor } from '../db/repositories/index.js';

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

describe('Quote PDF Generation Service', () => {
  it('renders a complete quote into a valid PDF buffer', async () => {
    const mockQuote = {
      id: 'q_unit_test_1',
      quoteNumber: 'Q-2026-101',
      title: 'Enterprise CRM Annual Contract',
      status: 'Sent',
      contactName: 'Sarah Connor',
      companyName: 'Cyberdyne Systems',
      contactEmail: 'sarah@cyberdyne.test',
      createdAt: '2026-09-01T10:00:00.000Z',
      expirationDate: '2026-10-01T23:59:59.000Z',
      items: [
        {
          id: 'item_1',
          description: 'Enterprise Cloud Seats (x10)',
          sku: 'SEAT-ENT-10',
          quantity: 10,
          unitPrice: 150,
          amount: 1500,
        },
        {
          id: 'item_2',
          description: 'Custom Onboarding Package',
          quantity: 1,
          unitPrice: 2000,
          amount: 2000,
        },
      ],
      subtotal: 3500,
      discount: 250,
      tax: 325,
      total: 3575,
      notes: 'Payment terms: Net 30. Direct wire transfer or credit card accepted.',
    };

    const buffer = await renderQuotePdfBuffer(mockQuote);
    expect(buffer).toBeDefined();
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(1000);
    // Standard PDF header signature
    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('handles quotes with empty or missing line items gracefully', async () => {
    const emptyQuote = {
      id: 'q_empty_test',
      quoteNumber: 'Q-EMPTY',
      title: 'Consulting Retainer',
      items: [],
      total: 0,
    };

    const buffer = await renderQuotePdfBuffer(emptyQuote);
    expect(buffer).toBeDefined();
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders quote to a readable stream', async () => {
    const quote = {
      id: 'q_stream_test',
      quoteNumber: 'Q-STREAM',
      title: 'Stream Test',
      total: 100,
    };

    const stream = await renderQuotePdfStream(quote);
    expect(stream).toBeDefined();
    expect(typeof stream.pipe === 'function').toBe(true);

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const combined = Buffer.concat(chunks);
    expect(combined.length).toBeGreaterThan(500);
    expect(combined.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});

describe('GET /api/quotes/:id/pdf Route', () => {
  it('requires authentication (returns 401 without token)', async () => {
    const res = await request(app).get('/api/quotes/any_quote_id/pdf');
    expect(res.status).toBe(401);
  });

  it('returns 404 when quote does not exist', async () => {
    const res = await auth(request(app).get('/api/quotes/00000000-0000-0000-0000-000000000000/pdf'));
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'Quote not found');
  });

  it('streams PDF with correct headers for an existing quote', async () => {
    // 1. Create a quote in the PostgreSQL repository
    const createdQuote = await repoFor('quotes').create({
      workspace_id: 'default',
      title: 'Implementation Agreement',
      quote_number: 'Q-2026-999',
      status: 'Accepted',
      subtotal: 5000,
      discount: 500,
      tax: 450,
      total: 4950,
      items: [
        {
          description: 'Implementation & Configuration',
          quantity: 1,
          unit_price: 5000,
          amount: 5000,
        },
      ],
      notes: 'Standard SLA terms apply.',
    });
    expect(createdQuote).toBeDefined();
    expect(createdQuote.id).toBeDefined();

    // 2. Fetch the PDF stream
    const res = await auth(request(app).get(`/api/quotes/${createdQuote.id}/pdf`))
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/inline;\s*filename="quote-Q-2026-999\.pdf"/);

    const pdfBuffer = Buffer.from(res.body);
    expect(pdfBuffer.length).toBeGreaterThan(1000);
    expect(pdfBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('enriches quote PDF with company and contact information when referenced', async () => {
    // 1. Seed company and contact in Postgres
    const company = await repoFor('companies').create({
      workspace_id: 'default',
      name: 'Stark Industries',
      domain: 'stark.test',
    });

    const contact = await repoFor('contacts').create({
      workspace_id: 'default',
      first_name: 'Tony',
      last_name: 'Stark',
      email: 'tony@stark.test',
      company_id: company.id,
    });

    // 2. Create quote referencing company_id and contact_id
    const quote = await repoFor('quotes').create({
      workspace_id: 'default',
      title: 'Clean Energy Arc Reactor Pilot',
      quote_number: 'Q-STARK-01',
      company_id: company.id,
      contact_id: contact.id,
      total: 150000,
      items: [
        { description: 'Arc Mini Reactor', quantity: 2, unitPrice: 75000, amount: 150000 },
      ],
    });

    // 3. Request PDF
    const res = await auth(request(app).get(`/api/quotes/${quote.id}/pdf`))
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('quote-Q-STARK-01.pdf');

    const pdfBuffer = Buffer.from(res.body);
    expect(pdfBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
