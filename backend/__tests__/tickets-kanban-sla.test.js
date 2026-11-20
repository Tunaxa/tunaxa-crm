import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  cleanupTestDb,
  loginAs,
  resetTestDb,
  seedTestUser,
} from './setup.js';
import { mutateDb } from '../store.js';
import { query } from '../db/pg.js';
import {
  DEFAULT_SLA_TARGETS,
  computeSlaDueDates,
  evaluateSlaBreach,
  normalizePriority,
  resolveSlaTarget,
} from '../services/sla.js';
import {
  KANBAN_STAGES,
  buildStageSummary,
  canTransition,
  isTerminalStage,
  isValidStage,
} from '../services/ticket-stages.js';

let app;
let adminToken;
let memberToken;
let tenantBToken;

const as = (token) => ({ Authorization: `Bearer ${token}` });

async function createUser({ email, role, workspaceId }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('test123', salt, 64).toString('hex');
  const password = `${salt}:${hash}`;
  await mutateDb((db) => {
    db.users.push({
      id: `usr_${crypto.randomUUID()}`,
      name: email,
      email,
      password,
      role,
      workspaceId,
      createdAt: new Date().toISOString(),
    });
  });
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'test123' });
  if (response.status !== 200) {
    throw new Error(`login failed for ${email}: ${response.status}`);
  }
  return response.body.token;
}

async function createTicket(token, fields = {}) {
  return request(app)
    .post('/api/tickets')
    .set(as(token))
    .send({ subject: 'Ticket', ...fields });
}

const getTicket = (token, ticketId) =>
  request(app).get(`/api/tickets/${ticketId}`).set(as(token));

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  adminToken = await loginAs(app);
  memberToken = await createUser({
    email: 'member-ticket@test.com',
    role: 'member',
    workspaceId: 'default',
  });
  tenantBToken = await createUser({
    email: 'tenantb-ticket@test.com',
    role: 'Owner',
    workspaceId: 'tenant-b',
  });
}, 30000);

afterAll(async () => {
  try {
    await query(
      "DELETE FROM tickets WHERE workspace_id IN ('default', 'tenant-b')",
    );
  } catch {
    void 0;
  }
  await mutateDb((db) => {
    db.tickets = (db.tickets || []).filter(
      (t) => !['default', 'tenant-b'].includes(t.workspaceId || t.workspace_id),
    );
    delete db.ticketSla;
  });
  await cleanupTestDb();
});

describe('SLA engine (pure)', () => {
  it('computes due dates from the priority tier', () => {
    const createdAt = '2026-01-01T00:00:00.000Z';

    const normal = computeSlaDueDates({ priority: 'Normal', createdAt });
    expect(normal.firstResponseDueAt).toBe('2026-01-01T04:00:00.000Z');
    expect(normal.slaDueAt).toBe('2026-01-03T00:00:00.000Z');

    const high = computeSlaDueDates({ priority: 'High', createdAt });
    expect(high.firstResponseDueAt).toBe('2026-01-01T02:00:00.000Z');
    expect(high.slaDueAt).toBe('2026-01-01T08:00:00.000Z');
  });

  it('falls back to Normal for unknown/missing priority', () => {
    expect(normalizePriority('Platinum')).toBe('normal');
    expect(normalizePriority(undefined)).toBe('normal');
    expect(normalizePriority('HIGH')).toBe('high');
    expect(resolveSlaTarget('Platinum')).toEqual(DEFAULT_SLA_TARGETS.normal);
  });

  it('lets an explicit workspace override win over the priority tier', () => {
    expect(
      resolveSlaTarget('High', { firstResponseHours: 10, resolutionHours: 20 }),
    ).toEqual({ firstResponseHours: 10, resolutionHours: 20 });

    const due = computeSlaDueDates({
      priority: 'High',
      createdAt: '2026-01-01T00:00:00.000Z',
      settings: { firstResponseHours: 1, resolutionHours: 2 },
    });
    expect(due.slaDueAt).toBe('2026-01-01T02:00:00.000Z');
  });

  it('flags first-response breach only while no response exists', () => {
    const ticket = {
      stage: 'New',
      createdAt: '2026-01-01T00:00:00.000Z',
      firstResponseDueAt: '2026-01-01T04:00:00.000Z',
      slaDueAt: '2026-01-03T00:00:00.000Z',
    };
    const now = '2026-01-01T05:00:00.000Z';

    const breached = evaluateSlaBreach(ticket, { now });
    expect(breached.firstResponseBreached).toBe(true);
    expect(breached.resolutionBreached).toBe(false);

    const responded = evaluateSlaBreach(
      { ...ticket, firstResponseAt: '2026-01-01T03:00:00.000Z' },
      { now },
    );
    expect(responded.firstResponseBreached).toBe(false);
  });

  it('flags resolution breach on active tickets but not terminal ones', () => {
    const base = {
      createdAt: '2026-01-01T00:00:00.000Z',
      firstResponseAt: '2026-01-01T01:00:00.000Z',
      firstResponseDueAt: '2026-01-01T04:00:00.000Z',
      slaDueAt: '2026-01-01T06:00:00.000Z',
    };
    const now = '2026-01-01T07:00:00.000Z';

    expect(
      evaluateSlaBreach({ ...base, stage: 'In Progress' }, { now }).resolutionBreached,
    ).toBe(true);
    expect(
      evaluateSlaBreach({ ...base, stage: 'Resolved' }, { now }).resolutionBreached,
    ).toBe(false);
    expect(evaluateSlaBreach({ ...base, stage: 'Closed' }, { now }).isBreached).toBe(
      false,
    );
  });
});

describe('ticket stage model (pure)', () => {
  it('exposes canonical Kanban stages and terminal stages', () => {
    expect(KANBAN_STAGES).toEqual([
      'New',
      'In Progress',
      'Awaiting Client',
      'Resolved',
    ]);
    expect(isTerminalStage('Resolved')).toBe(true);
    expect(isTerminalStage('Closed')).toBe(true);
    expect(isTerminalStage('New')).toBe(false);
  });

  it('validates stages and declared transitions (idempotent no-op allowed)', () => {
    expect(isValidStage('New')).toBe(true);
    expect(isValidStage('Closed')).toBe(true);
    expect(isValidStage('Shipped')).toBe(false);
    expect(canTransition('New', 'In Progress')).toBe(true);
    expect(canTransition('In Progress', 'Resolved')).toBe(true);
    expect(canTransition('Resolved', 'Closed')).toBe(true);
    expect(canTransition('New', 'Closed')).toBe(false);
    expect(canTransition('Resolved', 'New')).toBe(false);
    expect(canTransition('New', 'New')).toBe(true);
  });

  it('builds stage summary with dynamic Closed/unknown columns', () => {
    expect(buildStageSummary([{ stage: 'New' }])).toEqual([
      { stage: 'New', count: 1 },
      { stage: 'In Progress', count: 0 },
      { stage: 'Awaiting Client', count: 0 },
      { stage: 'Resolved', count: 0 },
    ]);
    const five = buildStageSummary([{ stage: 'New' }, { stage: 'Closed' }]);
    expect(five.map((s) => s.stage)).toContain('Closed');
    expect(buildStageSummary([{ stage: 'Escalated' }]).map((s) => s.stage)).toContain(
      'Escalated',
    );
  });
});

describe('tickets Kanban & SLA API (tenant-scoped, dev-compatible)', () => {
  it('creates a ticket with SLA due dates and initial stage history', async () => {
    const res = await createTicket(adminToken, {
      subject: 'Create SLA',
      priority: 'High',
    });
    expect(res.status).toBe(201);
    expect(res.body.stage).toBe('New');
    expect(Array.isArray(res.body.stageHistory)).toBe(true);
    expect(res.body.stageHistory).toHaveLength(1);
    expect(res.body.stageHistory[0]).toMatchObject({ stage: 'New' });
    expect(typeof res.body.firstResponseDueAt).toBe('string');
    expect(typeof res.body.slaDueAt).toBe('string');
    expect(res.body.isBreached).toBe(false);
  });

  it('lists tickets with dev envelope (data,total,page,limit) and board stages/sla', async () => {
    await createTicket(adminToken, { subject: 'List SLA', priority: 'Normal' });
    const res = await request(app).get('/api/tickets').set(as(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(25);
    expect(Array.isArray(res.body.stages)).toBe(true);
    expect(res.body).toHaveProperty('sla');
    const row = res.body.data.find((t) => t.subject === 'List SLA');
    expect(row).toBeTruthy();
    expect(typeof row.firstResponseDueAt).toBe('string');
    expect(row.isBreached).toBe(false);
  });

  it('supports stage transitions, idempotent same-stage updates, and invalid transitions (400)', async () => {
    const created = await createTicket(adminToken, { subject: 'Move ticket' });
    const id = created.body.id;

    const moved = await request(app)
      .put(`/api/tickets/${id}`)
      .set(as(adminToken))
      .send({ stage: 'In Progress' });
    expect(moved.status).toBe(200);
    expect(moved.body.stage).toBe('In Progress');
    expect(moved.body.firstResponseAt).toBeTruthy();
    expect(moved.body.stageHistory.length).toBeGreaterThanOrEqual(2);

    const noop = await request(app)
      .put(`/api/tickets/${id}`)
      .set(as(adminToken))
      .send({ stage: 'In Progress' });
    expect(noop.status).toBe(200);
    expect(noop.body.stage).toBe('In Progress');
    expect(noop.body.stageHistory.length).toBe(moved.body.stageHistory.length);

    const badStage = await request(app)
      .put(`/api/tickets/${id}`)
      .set(as(adminToken))
      .send({ stage: 'Shipped' });
    expect(badStage.status).toBe(400);

    const illegal = await request(app)
      .put(`/api/tickets/${id}`)
      .set(as(adminToken))
      .send({ stage: 'Closed' });
    expect(illegal.status).toBe(400);
  });

  it('records resolvedAt/closedAt, stageHistory, and returns ticket detail', async () => {
    const created = await createTicket(adminToken, { subject: 'Lifecycle ticket' });
    const id = created.body.id;
    const put = (stage) =>
      request(app).put(`/api/tickets/${id}`).set(as(adminToken)).send({ stage });

    expect((await put('In Progress')).status).toBe(200);
    const resolved = await put('Resolved');
    expect(resolved.status).toBe(200);
    expect(resolved.body.resolvedAt).toBeTruthy();

    const closed = await put('Closed');
    expect(closed.status).toBe(200);
    expect(closed.body.stage).toBe('Closed');
    expect(closed.body.closedAt).toBeTruthy();
    expect(closed.body.resolvedAt).toBeTruthy();
    expect(closed.body.stageHistory.map((h) => h.stage)).toEqual([
      'New',
      'In Progress',
      'Resolved',
      'Closed',
    ]);

    const detail = await getTicket(adminToken, id);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(id);
    expect(detail.body).toHaveProperty('sla');
  });

  it('stamps firstResponseAt on first comment', async () => {
    const created = await createTicket(adminToken, { subject: 'Comment response' });
    const id = created.body.id;
    const comment = await request(app)
      .post(`/api/tickets/${id}/comment`)
      .set(as(adminToken))
      .send({ body: 'Hello' });
    expect(comment.status).toBe(201);
    expect(comment.body.firstResponseAt).toBeTruthy();
  });

  it('returns SLA summary with extended counters', async () => {
    const res = await request(app).get('/api/tickets/sla/summary').set(as(adminToken));
    expect(res.status).toBe(200);
    expect(typeof res.body.open).toBe('number');
    expect(typeof res.body.resolved).toBe('number');
    expect(typeof res.body.breached).toBe('number');
    expect(typeof res.body.pending).toBe('number');
    expect(typeof res.body.ok).toBe('number');
    expect(typeof res.body.resolutionBreached).toBe('number');
    expect(res.body.firstResponseBreached).toBe(res.body.breached);
    expect(res.body).toHaveProperty('sla');
  });

  it('computes breach flags from due dates', async () => {
    const created = await createTicket(adminToken, {
      subject: 'Breach ticket',
      priority: 'High',
    });
    const id = created.body.id;
    try {
      await query(
        "UPDATE tickets SET sla_due_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
        [id],
      );
    } catch {
      return;
    }
    const res = await getTicket(adminToken, id);
    expect(res.status).toBe(200);
    expect(res.body.resolutionBreached).toBe(true);
    expect(res.body.isBreached).toBe(true);
  });
});

describe('tickets security, validation, and tenant isolation', () => {
  it('rejects non-admin SLA config updates (403), out-of-bounds hours (400), and prototype-pollution keys (400)', async () => {
    const forbidden = await request(app)
      .put('/api/tickets/sla')
      .set(as(memberToken))
      .send({ firstResponseHours: 2, resolutionHours: 4 });
    expect(forbidden.status).toBe(403);

    const badHours = await request(app)
      .put('/api/tickets/sla')
      .set(as(adminToken))
      .send({ firstResponseHours: 0, resolutionHours: 4 });
    expect(badHours.status).toBe(400);

    const huge = await request(app)
      .put('/api/tickets/sla')
      .set(as(adminToken))
      .send({ firstResponseHours: 99999, resolutionHours: 4 });
    expect(huge.status).toBe(400);

    const proto = await request(app)
      .put('/api/tickets/sla')
      .set(as(adminToken))
      .send(
        JSON.parse('{"firstResponseHours":2,"resolutionHours":4,"__proto__":{"x":1}}'),
      );
    expect([400, 403]).toContain(proto.status);
    expect(proto.status).not.toBe(200);
  });

  it('rejects prototype-pollution keys on ticket create/update/comment', async () => {
    const badCreate = await request(app)
      .post('/api/tickets')
      .set(as(adminToken))
      .send(
        JSON.parse('{"subject":"X","__proto__":{"polluted":true}}'),
      );
    expect(badCreate.status).toBe(400);

    const created = await createTicket(adminToken, { subject: 'Proto target' });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const badUpdate = await request(app)
      .put(`/api/tickets/${id}`)
      .set(as(adminToken))
      .send(JSON.parse('{"description":"y","constructor":{"x":1}}'));
    expect(badUpdate.status).toBe(400);

    const badComment = await request(app)
      .post(`/api/tickets/${id}/comment`)
      .set(as(adminToken))
      .send(JSON.parse('{"body":"hi","prototype":{"x":1}}'));
    expect(badComment.status).toBe(400);
  });

  it('isolates tenants: B cannot see A on board/list/summary and gets 404 on A operations', async () => {
    const a = await createTicket(adminToken, { subject: 'Tenant A secret ticket' });
    expect(a.status).toBe(201);
    const aId = a.body.id;

    const listB = await request(app).get('/api/tickets').set(as(tenantBToken));
    expect(listB.status).toBe(200);
    expect((listB.body.data || []).some((t) => t.id === aId)).toBe(false);

    const summaryB = await request(app)
      .get('/api/tickets/sla/summary')
      .set(as(tenantBToken));
    expect(summaryB.status).toBe(200);
    expect(summaryB.body.open).toBe(0);
    expect(summaryB.body.resolved).toBe(0);

    const getB = await getTicket(tenantBToken, aId);
    expect(getB.status).toBe(404);

    const putB = await request(app)
      .put(`/api/tickets/${aId}`)
      .set(as(tenantBToken))
      .send({ description: 'hijack' });
    expect(putB.status).toBe(404);

    const commentB = await request(app)
      .post(`/api/tickets/${aId}/comment`)
      .set(as(tenantBToken))
      .send({ body: 'nope' });
    expect(commentB.status).toBe(404);

    const delB = await request(app)
      .delete(`/api/tickets/${aId}`)
      .set(as(tenantBToken));
    expect(delB.status).toBe(404);

    const getA = await getTicket(adminToken, aId);
    expect(getA.status).toBe(200);
  });
});