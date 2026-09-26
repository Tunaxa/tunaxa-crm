import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { app } from '../server.js';
import { resetTestDb, cleanupTestDb } from './setup.js';
import { query } from '../db/pg.js';
import { mutateDb } from '../store.js';
import {
  getGoalDateRange,
  computeGoalStatus,
  calculateGoalProgress,
} from '../services/goals.js';

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

  await mutateDb((db) => {
    db.users.push(
      {
        id: 'usr_admin',
        name: 'Admin User',
        email: 'admin@goalstest.com',
        password: makePassword(),
        role: 'admin',
        workspaceId: 'default',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'usr_member',
        name: 'Member User',
        email: 'member@goalstest.com',
        password: makePassword(),
        role: 'member',
        workspaceId: 'default',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'usr_viewer',
        name: 'Viewer User',
        email: 'viewer@goalstest.com',
        password: makePassword(),
        role: 'viewer',
        workspaceId: 'default',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'usr_acme',
        name: 'Acme Admin',
        email: 'acme@goalstest.com',
        password: makePassword(),
        role: 'admin',
        workspaceId: 'ws_acme',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'usr_globex',
        name: 'Globex Admin',
        email: 'globex@goalstest.com',
        password: makePassword(),
        role: 'admin',
        workspaceId: 'ws_globex',
        createdAt: new Date().toISOString(),
      }
    );
  });

  adminToken = await login('admin@goalstest.com');
  memberToken = await login('member@goalstest.com');
  viewerToken = await login('viewer@goalstest.com');
  acmeToken = await login('acme@goalstest.com');
  globexToken = await login('globex@goalstest.com');
});

afterAll(async () => {
  await cleanupTestDb();
});

describe('Goal Service Unit Functions', () => {
  it('computes monthly, quarterly, and annual date ranges', () => {
    const fixedDate = new Date('2026-08-15T12:00:00Z');

    const monthlyRange = getGoalDateRange({ period: 'monthly' }, fixedDate);
    expect(monthlyRange.startDate.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(monthlyRange.endDate.toISOString()).toBe('2026-08-31T23:59:59.999Z');

    const quarterlyRange = getGoalDateRange({ period: 'quarterly' }, fixedDate);
    expect(quarterlyRange.startDate.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(quarterlyRange.endDate.toISOString()).toBe('2026-09-30T23:59:59.999Z');

    const annualRange = getGoalDateRange({ period: 'annual' }, fixedDate);
    expect(annualRange.startDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(annualRange.endDate.toISOString()).toBe('2026-12-31T23:59:59.999Z');
  });

  it('uses custom startDate and endDate if provided', () => {
    const custom = {
      startDate: '2026-03-01T00:00:00.000Z',
      endDate: '2026-06-30T23:59:59.999Z',
    };
    const range = getGoalDateRange(custom);
    expect(range.startDate.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(range.endDate.toISOString()).toBe('2026-06-30T23:59:59.999Z');
  });

  it('determines pace status (achieved, on_track, at_risk, behind)', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-01-31T23:59:59Z');
    const mid = new Date('2026-01-16T00:00:00Z'); // ~50% elapsed

    // Target 100
    expect(computeGoalStatus(100, 100, start, end, mid)).toBe('achieved');
    expect(computeGoalStatus(100, 120, start, end, mid)).toBe('achieved');

    // Expected pace at 50% is 50. Actual 50 is on track.
    expect(computeGoalStatus(100, 50, start, end, mid)).toBe('on_track');
    // Actual 35 is at risk
    expect(computeGoalStatus(100, 35, start, end, mid)).toBe('at_risk');
    // Actual 10 is behind
    expect(computeGoalStatus(100, 10, start, end, mid)).toBe('behind');

    // After period end, if not achieved, it is behind
    const after = new Date('2026-02-01T00:00:00Z');
    expect(computeGoalStatus(100, 90, start, end, after)).toBe('behind');
  });
});

describe('Goal CRUD API & Validation', () => {
  let createdGoalId;

  it('creates a goal with valid payload (POST /api/goals)', async () => {
    const res = await supertest(app)
      .post('/api/goals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Q3 Enterprise Revenue',
        type: 'revenue',
        target: 100000,
        period: 'quarterly',
        assignedTo: 'usr_member',
        assignedType: 'user',
        startDate: '2026-07-01T00:00:00.000Z',
        endDate: '2026-09-30T23:59:59.999Z',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('Q3 Enterprise Revenue');
    expect(res.body.type).toBe('revenue');
    expect(res.body.target).toBe(100000);
    expect(res.body.period).toBe('quarterly');
    expect(res.body.status).toBe('active');
    createdGoalId = res.body.id;
  });

  it('rejects goal creation with missing name', async () => {
    const res = await supertest(app)
      .post('/api/goals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        type: 'revenue',
        target: 50000,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  it('rejects goal creation with invalid type', async () => {
    const res = await supertest(app)
      .post('/api/goals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Invalid Type Goal',
        type: 'crypto_revenue',
        target: 50000,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid goal type/i);
  });

  it('rejects goal creation with invalid period', async () => {
    const res = await supertest(app)
      .post('/api/goals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Invalid Period Goal',
        type: 'revenue',
        period: 'biweekly',
        target: 50000,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid goal period/i);
  });

  it('rejects goal creation with non-positive target', async () => {
    const res = await supertest(app)
      .post('/api/goals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Negative Target Goal',
        type: 'revenue',
        target: -100,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/target must be a valid positive number/i);
  });

  it('enforces RBAC: viewer role cannot create goals', async () => {
    const res = await supertest(app)
      .post('/api/goals')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({
        name: 'Viewer Goal',
        type: 'revenue',
        target: 10000,
      });
    expect(res.status).toBe(403);
  });

  it('lists goals with pagination parameters (GET /api/goals?page=1&limit=10)', async () => {
    const res = await supertest(app)
      .get('/api/goals?page=1&limit=10')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(10);
    expect(res.body.totalPages).toBeGreaterThanOrEqual(1);
  });

  it('filters goals by status and type', async () => {
    const res = await supertest(app)
      .get('/api/goals?status=active&type=revenue&page=1&limit=10')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.every((g) => g.status === 'active' && g.type === 'revenue')).toBe(true);
  });

  it('returns array for backward compatibility when requested without paging params', async () => {
    const res = await supertest(app)
      .get('/api/goals')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('fetches a single goal by ID (GET /api/goals/:id)', async () => {
    const res = await supertest(app)
      .get(`/api/goals/${createdGoalId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(createdGoalId);
    expect(res.body.name).toBe('Q3 Enterprise Revenue');
  });

  it('returns 404 for non-existent goal ID', async () => {
    const res = await supertest(app)
      .get('/api/goals/goal_nonexistent')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('updates goal target and metadata (PUT /api/goals/:id)', async () => {
    const res = await supertest(app)
      .put(`/api/goals/${createdGoalId}`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        target: 125000,
        name: 'Q3 Enterprise Revenue (Updated)',
        status: 'active',
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(createdGoalId);
    expect(res.body.target).toBe(125000);
    expect(res.body.name).toBe('Q3 Enterprise Revenue (Updated)');
  });

  it('deletes a goal (DELETE /api/goals/:id)', async () => {
    const res = await supertest(app)
      .delete(`/api/goals/${createdGoalId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);

    const getRes = await supertest(app)
      .get(`/api/goals/${createdGoalId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.status).toBe(404);
  });
});

describe('Live Progress Calculation (GET /api/goals/:id/progress)', () => {
  it('calculates live progress for a revenue goal', async () => {
    // 1. Create a monthly revenue goal
    const goalRes = await supertest(app)
      .post('/api/goals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Monthly Revenue Goal',
        type: 'revenue',
        target: 100000,
        period: 'monthly',
      });
    expect(goalRes.status).toBe(201);
    const goalId = goalRes.body.id;

    // 2. Seed deals:
    // Deal 1: Closed Won, $60,000 (current date)
    // Deal 2: Closed Won, $40,000 (current date)
    // Deal 3: Proposal (not won), $50,000 (should NOT count)
    // Deal 4: Closed Won, $25,000 in past month (should NOT count)
    const now = new Date();
    const pastMonth = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);

    await query(
      `INSERT INTO deals (workspace_id, title, value, stage, created_at)
       VALUES
         ('default', 'Deal Alpha', 60000, 'Closed Won', $1),
         ('default', 'Deal Beta', 40000, 'Closed Won', $1),
         ('default', 'Deal Gamma', 50000, 'Proposal', $1),
         ('default', 'Deal Delta', 25000, 'Closed Won', $2)`,
      [now.toISOString(), pastMonth.toISOString()]
    );

    // 3. Fetch progress
    const res = await supertest(app)
      .get(`/api/goals/${goalId}/progress`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.target).toBe(100000);
    expect(res.body.actual).toBe(100000);
    expect(res.body.percentage).toBe(100);
    expect(res.body.remaining).toBe(0);
    expect(res.body.status).toBe('achieved');
    expect(res.body.period).toBe('monthly');
  });

  it('calculates live progress for an activity goal assigned to a user', async () => {
    // 1. Create an activity goal
    const goalRes = await supertest(app)
      .post('/api/goals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'User Call Activity Target',
        type: 'activity',
        target: 5,
        period: 'monthly',
        assignedTo: 'usr_member',
      });
    expect(goalRes.status).toBe(201);
    const goalId = goalRes.body.id;

    const now = new Date();
    const pastMonth = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);

    // 2. Seed activities:
    // 3 for usr_member (current period)
    // 2 for usr_admin (current period, different user)
    // 2 for usr_member (outside period)
    await query(
      `INSERT INTO activities (workspace_id, type, user_id, title, created_at)
       VALUES
         ('default', 'Call', 'usr_member', 'Call 1', $1),
         ('default', 'Call', 'usr_member', 'Call 2', $1),
         ('default', 'Call', 'usr_member', 'Call 3', $1),
         ('default', 'Call', 'usr_admin', 'Call Admin', $1),
         ('default', 'Call', 'usr_admin', 'Call Admin 2', $1),
         ('default', 'Call', 'usr_member', 'Old Call', $2)`,
      [now.toISOString(), pastMonth.toISOString()]
    );

    // 3. Fetch progress
    const res = await supertest(app)
      .get(`/api/goals/${goalId}/progress`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.target).toBe(5);
    expect(res.body.actual).toBe(3);
    expect(res.body.percentage).toBe(60);
    expect(res.body.remaining).toBe(2);
  });

  it('calculates live progress for a deal creation goal', async () => {
    const goalRes = await supertest(app)
      .post('/api/goals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Deal Creation Target',
        type: 'deal',
        target: 4,
        period: 'monthly',
      });
    expect(goalRes.status).toBe(201);
    const goalId = goalRes.body.id;

    const res = await supertest(app)
      .get(`/api/goals/${goalId}/progress`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.target).toBe(4);
    expect(res.body.actual).toBeGreaterThanOrEqual(2);
    expect(res.body.remaining).toBeLessThanOrEqual(2);
  });

  it('returns 404 for progress calculation on non-existent goal', async () => {
    const res = await supertest(app)
      .get('/api/goals/goal_does_not_exist/progress')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe('Tenant Workspace Isolation', () => {
  let acmeGoalId;
  let globexGoalId;

  beforeAll(async () => {
    // Acme creates a goal
    const acmeGoal = await supertest(app)
      .post('/api/goals')
      .set('Authorization', `Bearer ${acmeToken}`)
      .send({
        name: 'Acme Q3 Revenue',
        type: 'revenue',
        target: 50000,
        period: 'monthly',
      });
    acmeGoalId = acmeGoal.body.id;

    // Globex creates a goal
    const globexGoal = await supertest(app)
      .post('/api/goals')
      .set('Authorization', `Bearer ${globexToken}`)
      .send({
        name: 'Globex Q3 Revenue',
        type: 'revenue',
        target: 90000,
        period: 'monthly',
      });
    globexGoalId = globexGoal.body.id;

    // Seed deals in both workspaces
    const now = new Date().toISOString();
    await query(
      `INSERT INTO deals (workspace_id, title, value, stage, created_at)
       VALUES
         ('ws_acme', 'Acme Deal 1', 30000, 'Closed Won', $1),
         ('ws_acme', 'Acme Deal 2', 20000, 'Closed Won', $1),
         ('ws_globex', 'Globex Deal 1', 85000, 'Closed Won', $1)`,
      [now]
    );
  });

  it('Acme user only sees Acme goals in list', async () => {
    const res = await supertest(app)
      .get('/api/goals?page=1&limit=10')
      .set('Authorization', `Bearer ${acmeToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.every((g) => g.id !== globexGoalId)).toBe(true);
    expect(res.body.data.some((g) => g.id === acmeGoalId)).toBe(true);
  });

  it('Acme user calculates progress strictly from Acme deals', async () => {
    const res = await supertest(app)
      .get(`/api/goals/${acmeGoalId}/progress`)
      .set('Authorization', `Bearer ${acmeToken}`);

    expect(res.status).toBe(200);
    expect(res.body.target).toBe(50000);
    // Acme has 30,000 + 20,000 = 50,000
    expect(res.body.actual).toBe(50000);
    expect(res.body.percentage).toBe(100);
    expect(res.body.status).toBe('achieved');
  });

  it('Globex user cannot access Acme goal or its progress', async () => {
    const getRes = await supertest(app)
      .get(`/api/goals/${acmeGoalId}`)
      .set('Authorization', `Bearer ${globexToken}`);
    expect(getRes.status).toBe(404);

    const progRes = await supertest(app)
      .get(`/api/goals/${acmeGoalId}/progress`)
      .set('Authorization', `Bearer ${globexToken}`);
    expect(progRes.status).toBe(404);

    const putRes = await supertest(app)
      .put(`/api/goals/${acmeGoalId}`)
      .set('Authorization', `Bearer ${globexToken}`)
      .send({ target: 99999 });
    expect(putRes.status).toBe(404);

    const delRes = await supertest(app)
      .delete(`/api/goals/${acmeGoalId}`)
      .set('Authorization', `Bearer ${globexToken}`);
    expect(delRes.status).toBe(404);
  });
});
