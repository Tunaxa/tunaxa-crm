import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import supertest from 'supertest';
import { app } from '../server.js';
import { resetTestDb, cleanupTestDb } from './setup.js';
import { query } from '../db/pg.js';
import { mutateDb, readDb } from '../store.js';
import {
  runReportQuery,
  runJsonStoreReportQuery,
  resolveColumn,
  SUPPORTED_ENTITIES,
  ReportQueryError,
} from '../services/reports.js';

let adminToken;
let memberToken;
let viewerToken;
let acmeToken;
let globexToken;

function makePassword(password = 'test123') {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

async function login(email) {
  const res = await supertest(app)
    .post('/api/auth/login')
    .send({ email, password: 'test123' });
  return res.body.token;
}

beforeAll(async () => {
  await resetTestDb();

  // Seed users with various roles and workspaces
  await mutateDb((db) => {
    db.users.push(
      {
        id: 'usr_admin',
        name: 'Admin User',
        email: 'admin@reporttest.com',
        password: makePassword(),
        role: 'admin',
        workspaceId: 'default',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'usr_member',
        name: 'Member User',
        email: 'member@reporttest.com',
        password: makePassword(),
        role: 'member',
        workspaceId: 'default',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'usr_viewer',
        name: 'Viewer User',
        email: 'viewer@reporttest.com',
        password: makePassword(),
        role: 'viewer',
        workspaceId: 'default',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'usr_acme',
        name: 'Acme Admin',
        email: 'acme@reporttest.com',
        password: makePassword(),
        role: 'admin',
        workspaceId: 'ws_acme',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'usr_globex',
        name: 'Globex Admin',
        email: 'globex@reporttest.com',
        password: makePassword(),
        role: 'admin',
        workspaceId: 'ws_globex',
        createdAt: new Date().toISOString(),
      }
    );
  });

  adminToken = await login('admin@reporttest.com');
  memberToken = await login('member@reporttest.com');
  viewerToken = await login('viewer@reporttest.com');
  acmeToken = await login('acme@reporttest.com');
  globexToken = await login('globex@reporttest.com');
}, 30000);

afterAll(async () => {
  await cleanupTestDb();
});

describe('POST /api/reports/query - Custom Report Aggregation Engine', () => {
  describe('1. Authentication & RBAC Access Control', () => {
    it('rejects unauthenticated requests with 401 Unauthorized', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .send({ entity: 'deals', groupBy: 'stage', metric: 'count' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('rejects requests from viewer role with 403 Forbidden', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ entity: 'deals', groupBy: 'stage', metric: 'count' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Forbidden');
    });

    it('allows requests from member role with 200 OK', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ entity: 'deals', groupBy: 'stage', metric: 'count' });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('allows requests from admin role with 200 OK', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ entity: 'deals', groupBy: 'stage', metric: 'count' });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('2. Input Validation & SQL Injection Hardening', () => {
    it('returns 400 when entity is missing', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ groupBy: 'stage', metric: 'count' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('entity is required');
    });

    it('returns 400 when entity is unsupported or unknown', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ entity: 'secret_tokens', groupBy: 'stage', metric: 'count' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid or unsupported entity');
    });

    it('returns 400 when groupBy is missing', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ entity: 'deals', metric: 'count' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('groupBy is required');
    });

    it('returns 400 when metric is invalid', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ entity: 'deals', groupBy: 'stage', metric: 'median' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid metric');
    });

    it('returns 400 when field is missing for sum metric', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ entity: 'deals', groupBy: 'stage', metric: 'sum' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('field is required');
    });

    it('returns 400 when field is missing for avg metric', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ entity: 'deals', groupBy: 'stage', metric: 'avg' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('field is required');
    });

    it('rejects malicious SQL injection in groupBy with 400 Bad Request', async () => {
      const maliciousInputs = [
        'stage; DROP TABLE deals;--',
        'stage UNION SELECT * FROM users',
        'stage OR 1=1',
        "stage'--",
      ];

      for (const input of maliciousInputs) {
        const res = await supertest(app)
          .post('/api/reports/query')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ entity: 'deals', groupBy: input, metric: 'count' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Invalid groupBy');
      }
    });

    it('rejects malicious SQL injection in field with 400 Bad Request', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          entity: 'deals',
          groupBy: 'stage',
          metric: 'sum',
          field: 'value; DROP TABLE deals;--',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid field');
    });

    it('rejects invalid dateRange.from format with 400', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          entity: 'deals',
          groupBy: 'stage',
          metric: 'count',
          dateRange: { from: 'invalid-date-string' },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid dateRange.from format');
    });
  });

  describe('3. Metric Calculations (count, sum, avg) on Deals', () => {
    beforeAll(async () => {
      // Seed deals in PostgreSQL
      try {
        await query(`
          INSERT INTO deals (workspace_id, title, value, stage, created_at)
          VALUES
            ('default', 'Deal Alpha', 10000, 'Proposal', '2026-03-01T10:00:00Z'),
            ('default', 'Deal Beta', 20000, 'Proposal', '2026-03-02T10:00:00Z'),
            ('default', 'Deal Gamma', 30000, 'Negotiation', '2026-03-05T10:00:00Z'),
            ('default', 'Deal Delta', 50000, 'Closed Won', '2026-03-10T10:00:00Z'),
            ('default', 'Deal Epsilon', 100000, 'Closed Won', '2026-03-12T10:00:00Z'),
            ('default', 'Deal Zeta', 0, NULL, '2026-03-15T10:00:00Z')
        `);
      } catch (err) {
        // Fallback for tests if PG is down
        await mutateDb((db) => {
          db.deals.push(
            { id: 'd1', workspace_id: 'default', title: 'Deal Alpha', value: 10000, stage: 'Proposal', createdAt: '2026-03-01T10:00:00Z' },
            { id: 'd2', workspace_id: 'default', title: 'Deal Beta', value: 20000, stage: 'Proposal', createdAt: '2026-03-02T10:00:00Z' },
            { id: 'd3', workspace_id: 'default', title: 'Deal Gamma', value: 30000, stage: 'Negotiation', createdAt: '2026-03-05T10:00:00Z' },
            { id: 'd4', workspace_id: 'default', title: 'Deal Delta', value: 50000, stage: 'Closed Won', createdAt: '2026-03-10T10:00:00Z' },
            { id: 'd5', workspace_id: 'default', title: 'Deal Epsilon', value: 100000, stage: 'Closed Won', createdAt: '2026-03-12T10:00:00Z' },
            { id: 'd6', workspace_id: 'default', title: 'Deal Zeta', value: 0, stage: null, createdAt: '2026-03-15T10:00:00Z' }
          );
        });
      }
    });

    it('aggregates count grouped by stage', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ entity: 'deals', groupBy: 'stage', metric: 'count' });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const proposal = res.body.find((r) => r.group === 'Proposal');
      const closedWon = res.body.find((r) => r.group === 'Closed Won');
      const negotiation = res.body.find((r) => r.group === 'Negotiation');
      const unassigned = res.body.find((r) => r.group === 'Unassigned');

      expect(proposal).toBeDefined();
      expect(proposal.count).toBe(2);
      expect(proposal.value).toBe(2);

      expect(closedWon).toBeDefined();
      expect(closedWon.count).toBe(2);
      expect(closedWon.value).toBe(2);

      expect(negotiation).toBeDefined();
      expect(negotiation.count).toBe(1);
      expect(negotiation.value).toBe(1);

      expect(unassigned).toBeDefined();
      expect(unassigned.count).toBe(1);
    });

    it('aggregates sum of value grouped by stage', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ entity: 'deals', groupBy: 'stage', metric: 'sum', field: 'value' });

      expect(res.status).toBe(200);

      const closedWon = res.body.find((r) => r.group === 'Closed Won');
      const proposal = res.body.find((r) => r.group === 'Proposal');
      const negotiation = res.body.find((r) => r.group === 'Negotiation');

      expect(closedWon).toBeDefined();
      expect(closedWon.value).toBe(150000); // 50000 + 100000
      expect(closedWon.count).toBe(2);

      expect(proposal).toBeDefined();
      expect(proposal.value).toBe(30000); // 10000 + 20000
      expect(proposal.count).toBe(2);

      expect(negotiation).toBeDefined();
      expect(negotiation.value).toBe(30000);
      expect(negotiation.count).toBe(1);

      // Verify ordered by value DESC
      expect(res.body[0].value).toBeGreaterThanOrEqual(res.body[1].value);
    });

    it('aggregates avg of value rounded to 2 decimal places grouped by stage', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ entity: 'deals', groupBy: 'stage', metric: 'avg', field: 'value' });

      expect(res.status).toBe(200);

      const closedWon = res.body.find((r) => r.group === 'Closed Won');
      const proposal = res.body.find((r) => r.group === 'Proposal');

      expect(closedWon).toBeDefined();
      expect(closedWon.value).toBe(75000); // (50000 + 100000) / 2
      expect(proposal).toBeDefined();
      expect(proposal.value).toBe(15000); // (10000 + 20000) / 2
    });
  });

  describe('4. Date Range Filtering', () => {
    it('filters aggregation to records within dateRange.from and dateRange.to', async () => {
      // March 1 to March 4 should only include Proposal deals (March 1, 2)
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          entity: 'deals',
          groupBy: 'stage',
          metric: 'sum',
          field: 'value',
          dateRange: {
            from: '2026-03-01',
            to: '2026-03-04',
          },
          dateField: 'createdAt',
        });

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].group).toBe('Proposal');
      expect(res.body[0].value).toBe(30000);
      expect(res.body[0].count).toBe(2);
    });

    it('returns empty array when dateRange matches no records', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          entity: 'deals',
          groupBy: 'stage',
          metric: 'count',
          dateRange: {
            from: '2025-01-01',
            to: '2025-01-31',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('5. Cross-Entity Aggregations', () => {
    beforeAll(async () => {
      // Seed invoices in PostgreSQL
      try {
        await query(`
          INSERT INTO invoices (workspace_id, invoice_number, total, status, created_at)
          VALUES
            ('default', 'INV-001', 500.50, 'Paid', '2026-04-01T10:00:00Z'),
            ('default', 'INV-002', 1500.00, 'Paid', '2026-04-02T10:00:00Z'),
            ('default', 'INV-003', 750.25, 'Sent', '2026-04-03T10:00:00Z'),
            ('default', 'INV-004', 300.00, 'Overdue', '2026-04-04T10:00:00Z')
        `);
      } catch (err) {
        await mutateDb((db) => {
          db.invoices.push(
            { id: 'inv1', workspace_id: 'default', invoiceNumber: 'INV-001', total: 500.5, status: 'Paid', createdAt: '2026-04-01T10:00:00Z' },
            { id: 'inv2', workspace_id: 'default', invoiceNumber: 'INV-002', total: 1500, status: 'Paid', createdAt: '2026-04-02T10:00:00Z' },
            { id: 'inv3', workspace_id: 'default', invoiceNumber: 'INV-003', total: 750.25, status: 'Sent', createdAt: '2026-04-03T10:00:00Z' },
            { id: 'inv4', workspace_id: 'default', invoiceNumber: 'INV-004', total: 300, status: 'Overdue', createdAt: '2026-04-04T10:00:00Z' }
          );
        });
      }

      // Seed tickets in PostgreSQL
      try {
        await query(`
          INSERT INTO tickets (workspace_id, subject, priority, stage, created_at)
          VALUES
            ('default', 'Bug in login', 'High', 'Open', '2026-04-05T10:00:00Z'),
            ('default', 'Billing inquiry', 'High', 'Open', '2026-04-06T10:00:00Z'),
            ('default', 'Feature request', 'Low', 'Resolved', '2026-04-07T10:00:00Z')
        `);
      } catch (err) {
        await mutateDb((db) => {
          db.tickets.push(
            { id: 't1', workspace_id: 'default', subject: 'Bug in login', priority: 'High', stage: 'Open', createdAt: '2026-04-05T10:00:00Z' },
            { id: 't2', workspace_id: 'default', subject: 'Billing inquiry', priority: 'High', stage: 'Open', createdAt: '2026-04-06T10:00:00Z' },
            { id: 't3', workspace_id: 'default', subject: 'Feature request', priority: 'Low', stage: 'Resolved', createdAt: '2026-04-07T10:00:00Z' }
          );
        });
      }
    });

    it('aggregates invoices sum of amount grouped by status', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ entity: 'invoices', groupBy: 'status', metric: 'sum', field: 'amount' });

      expect(res.status).toBe(200);
      const paid = res.body.find((r) => r.group === 'Paid');
      const sent = res.body.find((r) => r.group === 'Sent');
      const overdue = res.body.find((r) => r.group === 'Overdue');

      expect(paid).toBeDefined();
      expect(paid.value).toBe(2000.5); // 500.50 + 1500.00
      expect(paid.count).toBe(2);

      expect(sent).toBeDefined();
      expect(sent.value).toBe(750.25);
      expect(sent.count).toBe(1);

      expect(overdue).toBeDefined();
      expect(overdue.value).toBe(300);
      expect(overdue.count).toBe(1);
    });

    it('aggregates tickets count grouped by priority', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ entity: 'tickets', groupBy: 'priority', metric: 'count' });

      expect(res.status).toBe(200);
      const high = res.body.find((r) => r.group === 'High');
      const low = res.body.find((r) => r.group === 'Low');

      expect(high).toBeDefined();
      expect(high.count).toBe(2);
      expect(low).toBeDefined();
      expect(low.count).toBe(1);
    });
  });

  describe('6. Tenant Workspace Isolation', () => {
    beforeAll(async () => {
      try {
        await query(`
          INSERT INTO deals (workspace_id, title, value, stage)
          VALUES
            ('ws_acme', 'Acme Deal 1', 75000, 'Won'),
            ('ws_acme', 'Acme Deal 2', 25000, 'Won'),
            ('ws_globex', 'Globex Giant Deal', 1000000, 'Won')
        `);
      } catch (err) {
        await mutateDb((db) => {
          db.deals.push(
            { id: 'acme_d1', workspace_id: 'ws_acme', title: 'Acme Deal 1', value: 75000, stage: 'Won' },
            { id: 'acme_d2', workspace_id: 'ws_acme', title: 'Acme Deal 2', value: 25000, stage: 'Won' },
            { id: 'globex_d1', workspace_id: 'ws_globex', title: 'Globex Giant Deal', value: 1000000, stage: 'Won' }
          );
        });
      }
    });

    it('isolates Acme workspace and excludes Globex deals', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${acmeToken}`)
        .send({ entity: 'deals', groupBy: 'stage', metric: 'sum', field: 'value' });

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].group).toBe('Won');
      expect(res.body[0].value).toBe(100000); // 75000 + 25000
      expect(res.body[0].count).toBe(2);
    });

    it('isolates Globex workspace and excludes Acme deals', async () => {
      const res = await supertest(app)
        .post('/api/reports/query')
        .set('Authorization', `Bearer ${globexToken}`)
        .send({ entity: 'deals', groupBy: 'stage', metric: 'sum', field: 'value' });

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].group).toBe('Won');
      expect(res.body[0].value).toBe(1000000);
      expect(res.body[0].count).toBe(1);
    });
  });

  describe('7. In-Memory JSON Store Fallback Unit Testing', () => {
    it('executes runJsonStoreReportQuery fallback with count, sum, and avg metrics', async () => {
      await mutateDb((db) => {
        db.expenses = [
          { id: 'exp_1', workspace_id: 'ws_fallback', category: 'Software', amount: 100, date: '2026-05-01' },
          { id: 'exp_2', workspace_id: 'ws_fallback', category: 'Software', amount: 300, date: '2026-05-02' },
          { id: 'exp_3', workspace_id: 'ws_fallback', category: 'Travel', amount: 600, date: '2026-05-03' },
          { id: 'exp_4', workspace_id: 'ws_other', category: 'Software', amount: 999, date: '2026-05-04' },
        ];
      });

      // Test Sum
      const sumResult = await runJsonStoreReportQuery({
        entity: 'expenses',
        groupBy: 'category',
        groupByColumn: 'category',
        metric: 'sum',
        field: 'amount',
        fieldColumn: 'amount',
        workspaceId: 'ws_fallback',
      });

      expect(sumResult).toEqual([
        { group: 'Travel', value: 600, count: 1 },
        { group: 'Software', value: 400, count: 2 },
      ]);

      // Test Avg
      const avgResult = await runJsonStoreReportQuery({
        entity: 'expenses',
        groupBy: 'category',
        groupByColumn: 'category',
        metric: 'avg',
        field: 'amount',
        fieldColumn: 'amount',
        workspaceId: 'ws_fallback',
      });

      expect(avgResult).toEqual([
        { group: 'Travel', value: 600, count: 1 },
        { group: 'Software', value: 200, count: 2 }, // (100 + 300) / 2
      ]);

      // Test Date Filtering
      const dateFiltered = await runJsonStoreReportQuery({
        entity: 'expenses',
        groupBy: 'category',
        groupByColumn: 'category',
        metric: 'count',
        dateColumn: 'date',
        fromDate: '2026-05-01',
        toDate: '2026-05-02T23:59:59.999Z',
        workspaceId: 'ws_fallback',
      });

      expect(dateFiltered).toEqual([
        { group: 'Software', value: 2, count: 2 },
      ]);
    });
  });
});
