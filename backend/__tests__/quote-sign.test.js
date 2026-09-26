import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import {
  createQuoteSignToken,
  verifyQuoteSignToken,
  createQuoteShareLink,
} from '../services/quoteToken.js';
import { repoFor } from '../db/repositories/index.js';
import { readDb, mutateDb } from '../store.js';

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

const SAMPLE_SIGNATURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('Quote E-Signature Token Service (quoteToken.js)', () => {
  it('generates a valid signed token and verifies it successfully', () => {
    const quoteId = 'quote_unit_100';
    const token = createQuoteSignToken(quoteId, { expiresInMs: 3600000 });

    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(2);

    const result = verifyQuoteSignToken(token, quoteId);
    expect(result.valid).toBe(true);
    expect(result.payload.quoteId).toBe(quoteId);
    expect(result.payload.exp).toBeGreaterThan(Date.now());
  });

  it('rejects an expired token', () => {
    const quoteId = 'quote_expired_test';
    // Expired 5 seconds ago
    const token = createQuoteSignToken(quoteId, { expiresInMs: -5000 });

    const result = verifyQuoteSignToken(token, quoteId);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('expired');
  });

  it('rejects a token when quote ID does not match expected quote ID', () => {
    const token = createQuoteSignToken('quote_correct_id');
    const result = verifyQuoteSignToken(token, 'quote_other_id');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('mismatch');
  });

  it('rejects tampered tokens with invalid signatures', () => {
    const token = createQuoteSignToken('quote_tamper_test');
    const [payloadPart, sigPart] = token.split('.');

    // Tamper the payload part
    const tamperedPayload = Buffer.from(
      JSON.stringify({ quoteId: 'quote_tamper_test', exp: Date.now() + 100000, admin: true }),
    ).toString('base64url');
    const tamperedToken = `${tamperedPayload}.${sigPart}`;

    const result = verifyQuoteSignToken(tamperedToken, 'quote_tamper_test');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid');
  });

  it('creates share link with proper query parameter', () => {
    const link = createQuoteShareLink('q_link_1', { baseUrl: 'https://crm.example.com' });
    expect(link).toMatch(/^https:\/\/crm\.example\.com\/quotes\/q_link_1\/sign\?token=/);
  });
});

describe('E-Signature Routes', () => {
  describe('POST /api/quotes/:id/share-link', () => {
    it('requires authentication (401 without auth token)', async () => {
      const res = await request(app).post('/api/quotes/any_id/share-link').send({});
      expect(res.status).toBe(401);
    });

    it('returns 404 for non-existent quote', async () => {
      const res = await auth(
        request(app).post('/api/quotes/00000000-0000-0000-0000-000000000000/share-link'),
      ).send({});
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Quote not found');
    });

    it('generates a signing token and shareUrl for an existing quote', async () => {
      const quote = await repoFor('quotes').create({
        workspace_id: 'default',
        title: 'Share Link Test Quote',
        quote_number: 'Q-SHARE-01',
        total: 1200,
      });

      const res = await auth(request(app).post(`/api/quotes/${quote.id}/share-link`)).send({
        expiresInMs: 86400000,
      });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body).toHaveProperty('shareUrl', `/quotes/${quote.id}/sign?token=${res.body.token}`);
      expect(res.body).toHaveProperty('expiresAt');
    });
  });

  describe('POST /api/quotes/:id/sign (Public Signature Capture)', () => {
    it('rejects request with missing or invalid token', async () => {
      const res = await request(app)
        .post('/api/quotes/some_id/sign')
        .send({
          signatureDataUrl: SAMPLE_SIGNATURE,
          signerName: 'Bob Client',
          signerEmail: 'bob@client.test',
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/token/i);
    });

    it('rejects invalid or malformed signature data URL', async () => {
      const quote = await repoFor('quotes').create({
        workspace_id: 'default',
        title: 'Validation Quote',
        quote_number: 'Q-VAL-01',
        total: 500,
      });

      const token = createQuoteSignToken(quote.id);

      const res = await request(app)
        .post(`/api/quotes/${quote.id}/sign`)
        .send({
          token,
          signatureDataUrl: 'not-a-data-url',
          signerName: 'Bob Client',
          signerEmail: 'bob@client.test',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/signatureDataUrl/i);
    });

    it('rejects missing signer name or email format', async () => {
      const quote = await repoFor('quotes').create({
        workspace_id: 'default',
        title: 'Validation Quote 2',
        quote_number: 'Q-VAL-02',
        total: 500,
      });

      const token = createQuoteSignToken(quote.id);

      // Missing signer name
      const res1 = await request(app)
        .post(`/api/quotes/${quote.id}/sign`)
        .send({
          token,
          signatureDataUrl: SAMPLE_SIGNATURE,
          signerName: '',
          signerEmail: 'valid@client.test',
        });
      expect(res1.status).toBe(400);
      expect(res1.body.error).toMatch(/signerName/i);

      // Invalid email
      const res2 = await request(app)
        .post(`/api/quotes/${quote.id}/sign`)
        .send({
          token,
          signatureDataUrl: SAMPLE_SIGNATURE,
          signerName: 'Bob Client',
          signerEmail: 'not-an-email',
        });
      expect(res2.status).toBe(400);
      expect(res2.body.error).toMatch(/signerEmail/i);
    });

    it('returns 404 for non-existent quote even with a signed token', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';
      const token = createQuoteSignToken(nonExistentId);

      const res = await request(app)
        .post(`/api/quotes/${nonExistentId}/sign`)
        .send({
          token,
          signatureDataUrl: SAMPLE_SIGNATURE,
          signerName: 'Alice Client',
          signerEmail: 'alice@client.test',
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Quote not found');
    });

    it('successfully signs quote, logs audit metadata, and auto-creates Contract', async () => {
      // 1. Create company, contact, and quote
      const company = await repoFor('companies').create({
        workspace_id: 'default',
        name: 'Wayne Enterprises',
      });

      const contact = await repoFor('contacts').create({
        workspace_id: 'default',
        first_name: 'Bruce',
        last_name: 'Wayne',
        email: 'bruce@wayne.test',
        company_id: company.id,
      });

      const quote = await repoFor('quotes').create({
        workspace_id: 'default',
        title: 'Tactical Hardware Supply',
        quote_number: 'Q-WAYNE-007',
        status: 'Sent',
        company_id: company.id,
        contact_id: contact.id,
        subtotal: 50000,
        discount: 5000,
        tax: 4500,
        total: 49500,
        items: [{ description: 'High-Tensile Cable', quantity: 100, unitPrice: 500, amount: 50000 }],
        notes: 'Net 30 days. Delivery to Gotham docks.',
      });

      const token = createQuoteSignToken(quote.id);

      // 2. Submit signature
      const res = await request(app)
        .post(`/api/quotes/${quote.id}/sign`)
        .set('User-Agent', 'E-Sign-Browser-Agent/1.0')
        .send({
          token,
          signatureDataUrl: SAMPLE_SIGNATURE,
          signerName: 'Bruce Wayne',
          signerEmail: 'bruce@wayne.test',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // 3. Verify quote response and DB state
      expect(res.body.quote).toBeDefined();
      expect(res.body.quote.status).toBe('Signed');

      const updatedQuoteInDb = await repoFor('quotes').findById(quote.id);
      expect(updatedQuoteInDb.status).toBe('Signed');

      const sigMeta = updatedQuoteInDb.custom_fields?.signature;
      expect(sigMeta).toBeDefined();
      expect(sigMeta.signerName).toBe('Bruce Wayne');
      expect(sigMeta.signerEmail).toBe('bruce@wayne.test');
      expect(sigMeta.signatureDataUrl).toBe(SAMPLE_SIGNATURE);
      expect(sigMeta.signedAt).toBeDefined();
      expect(sigMeta.signerIp).toBeDefined();
      expect(sigMeta.userAgent).toBe('E-Sign-Browser-Agent/1.0');

      // 4. Verify auto-created Contract in response and DB
      expect(res.body.contract).toBeDefined();
      const contract = res.body.contract;
      expect(contract.title).toContain('Tactical Hardware Supply');
      expect(contract.contract_number || contract.contractNumber).toBe('C-WAYNE-007');
      expect(contract.quote_id || contract.quoteId).toBe(quote.id);
      expect(contract.company_id || contract.companyId).toBe(company.id);
      expect(contract.contact_id || contract.contactId).toBe(contact.id);
      expect(contract.status).toBe('Active');
      expect(Number(contract.value)).toBe(49500);

      const contractInDb = await repoFor('contracts').findById(contract.id);
      expect(contractInDb).toBeDefined();
      expect(contractInDb.quote_id).toBe(quote.id);
      expect(contractInDb.status).toBe('Active');
      expect(Number(contractInDb.value)).toBe(49500);
      expect(contractInDb.custom_fields?.signerEmail).toBe('bruce@wayne.test');
    });

    it('guards against double-signing an already signed quote (returns 409 Conflict)', async () => {
      const quote = await repoFor('quotes').create({
        workspace_id: 'default',
        title: 'Already Signed Quote',
        quote_number: 'Q-ALREADY-SIGNED',
        status: 'Signed',
        total: 1000,
      });

      const token = createQuoteSignToken(quote.id);

      const res = await request(app)
        .post(`/api/quotes/${quote.id}/sign`)
        .send({
          token,
          signatureDataUrl: SAMPLE_SIGNATURE,
          signerName: 'Duplicate Signer',
          signerEmail: 'dup@test.com',
        });

      expect([400, 409]).toContain(res.status);
      expect(res.body.error).toMatch(/already.*signed/i);
    });
  });

  describe('Post-Signing Automations (Workflow, Owner Notification & Audit Logging)', () => {
    it('dispatches quote.signed event to workflow engine and executes configured workflow', async () => {
      // 1. Seed a workflow listening for quote.signed
      await mutateDb((db) => {
        if (!Array.isArray(db.workflows)) db.workflows = [];
        db.workflows.push({
          id: 'wf_quote_signed_test',
          name: 'Quote Signed Auto Task',
          enabled: true,
          event: 'quote.signed',
          actions: [
            {
              id: 'act_1',
              type: 'task',
              title: 'Onboard Client for {{title}}',
              dueDate: new Date(Date.now() + 3 * 86400000).toISOString(),
            },
          ],
        });
      });

      // 2. Seed a quote
      const quote = await repoFor('quotes').create({
        workspace_id: 'default',
        title: 'Enterprise Security Package',
        quote_number: 'Q-AUTO-WF-01',
        status: 'Sent',
        total: 12000,
      });

      const signToken = createQuoteSignToken(quote.id);

      // 3. Sign the quote
      const res = await request(app)
        .post(`/api/quotes/${quote.id}/sign`)
        .send({
          token: signToken,
          signatureDataUrl: SAMPLE_SIGNATURE,
          signerName: 'Sarah Connor',
          signerEmail: 'sarah@connor.test',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // 4. Verify workflow execution generated the task
      const allTasks = await repoFor('tasks').findAll({ limit: 100 });
      const task = (allTasks?.data || allTasks?.items || []).find((t) => t.title && t.title.includes('Enterprise Security Package'));
      expect(task).toBeDefined();

      // 5. Verify workflow audit entry exists
      const db = await readDb();
      const wfAudit = (db.audit || []).find((a) => a.action && a.action.includes('Quote Signed Auto Task'));
      expect(wfAudit).toBeDefined();
    });

    it('sends email notification to the assigned deal owner upon quote signature', async () => {
      // 1. Seed owner user in db.users
      const ownerUser = {
        id: `usr_deal_owner_${Date.now()}`,
        name: 'Alex Sales Rep',
        email: 'alex.rep@tunaxa.test',
        role: 'Sales',
      };
      await mutateDb((db) => {
        if (!Array.isArray(db.users)) db.users = [];
        db.users.push(ownerUser);
      });

      // 2. Create deal with owner_id
      const deal = await repoFor('deals').create({
        workspace_id: 'default',
        title: 'Mega Deal 2026',
        owner_id: ownerUser.id,
        value: 75000,
        stage: 'Proposal',
      });

      // 3. Create quote linked to this deal
      const quote = await repoFor('quotes').create({
        workspace_id: 'default',
        title: 'Mega Deal Quote',
        quote_number: 'Q-DEAL-NOTIF-01',
        deal_id: deal.id,
        status: 'Sent',
        total: 75000,
      });

      const signToken = createQuoteSignToken(quote.id);

      // 4. Sign the quote
      const res = await request(app)
        .post(`/api/quotes/${quote.id}/sign`)
        .send({
          token: signToken,
          signatureDataUrl: SAMPLE_SIGNATURE,
          signerName: 'John Matrix',
          signerEmail: 'matrix@action.test',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // 5. Verify message/notification delivered to deal owner
      const db = await readDb();
      const ownerMessage = (db.messages || []).find((m) => m.to === 'alex.rep@tunaxa.test');
      expect(ownerMessage).toBeDefined();
      expect(ownerMessage.subject).toContain('Q-DEAL-NOTIF-01');
      expect(ownerMessage.body).toContain('John Matrix');
      expect(ownerMessage.body).toContain('matrix@action.test');
      expect(ownerMessage.body).toContain('Mega Deal 2026');
      expect(ownerMessage.body).toContain('75000');

      const ownerNotif = (db.notifications || []).find((n) => n.recipientEmail === 'alex.rep@tunaxa.test');
      expect(ownerNotif).toBeDefined();
      expect(ownerNotif.quoteId).toBe(quote.id);
      expect(ownerNotif.dealId).toBe(deal.id);
    });

    it('falls back gracefully when quote has no associated deal or owner', async () => {
      // Create quote without deal_id or owner
      const quote = await repoFor('quotes').create({
        workspace_id: 'default',
        title: 'Unassigned Quote',
        quote_number: 'Q-ORPHAN-01',
        status: 'Draft',
        total: 500,
      });

      const signToken = createQuoteSignToken(quote.id);

      const res = await request(app)
        .post(`/api/quotes/${quote.id}/sign`)
        .send({
          token: signToken,
          signatureDataUrl: SAMPLE_SIGNATURE,
          signerName: 'Anonymous Signer',
          signerEmail: 'anon@sign.test',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.quote.status).toBe('Signed');
      expect(res.body.contract).toBeDefined();
      expect(res.body.contract.status).toBe('Active');
    });

    it('records an audit trail entry for the signing event with signer metadata', async () => {
      const quote = await repoFor('quotes').create({
        workspace_id: 'default',
        title: 'Audit Trail Test Quote',
        quote_number: 'Q-AUDIT-01',
        status: 'Sent',
        total: 15000,
      });

      const signToken = createQuoteSignToken(quote.id);
      const testIp = '198.51.100.42';
      const testUa = 'AuditVerifierBot/2.0';

      const res = await request(app)
        .post(`/api/quotes/${quote.id}/sign`)
        .set('X-Forwarded-For', testIp)
        .set('User-Agent', testUa)
        .send({
          token: signToken,
          signatureDataUrl: SAMPLE_SIGNATURE,
          signerName: 'Ellen Ripley',
          signerEmail: 'ripley@weyland.test',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const db = await readDb();
      const auditEntry = (db.audit || []).find(
        (a) => a.action === 'quote.signed' && (a.entityId === quote.id || a.resourceId === quote.id)
      );

      expect(auditEntry).toBeDefined();
      expect(auditEntry.action).toBe('quote.signed');
      expect(auditEntry.entity).toBe('quotes');
      expect(auditEntry.actor.name).toBe('Ellen Ripley');
      expect(auditEntry.actor.email).toBe('ripley@weyland.test');
      expect(auditEntry.actor.type).toBe('external_signer');
      expect(auditEntry.actor.ip).toContain(testIp);
      expect(auditEntry.actor.userAgent).toBe(testUa);
      expect(auditEntry.details.quoteNumber).toBe('Q-AUDIT-01');
      expect(auditEntry.details.contractId).toBe(res.body.contract.id);
      expect(auditEntry.details.total).toBe(15000);
      expect(auditEntry.timestamp).toBeDefined();
      expect(auditEntry.createdAt).toBeDefined();
    });
  });
});
