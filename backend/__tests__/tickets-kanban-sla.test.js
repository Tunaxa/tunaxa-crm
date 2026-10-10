import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
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

// P2-BE2-02. The pure engine is exercised directly, then the same rules are
// driven through the API and read back out of Postgres, because the whole point
// of the ticket is that a stage move/computed deadline survives the round trip.

let app;
let token;

const auth = (req) => req.set('Authorization', `Bearer ${token}`);

async function createTicket(fields = {}) {
  return auth(request(app).post('/api/tickets')).send({
    subject: 'Ticket',
    ...fields,
  });
}

const getTicket = (ticketId) =>
  auth(request(app).get(`/api/tickets/${ticketId}`));

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
}, 30000);

afterAll(() => cleanupTestDb());

describe('SLA engine', () => {
  it('computes due dates from the priority tier', () => {
    const createdAt = '2026-01-01T00:00:00.000Z';

    const normal = computeSlaDueDates({ priority: 'Normal', createdAt });
    expect(normal.firstResponseDueAt).toBe('2026-01-01T04:00:00.000Z');
    expect(normal.slaDueAt).toBe('2026-01-03T00:00:00.000Z');

    const high = computeSlaDueDates({ priority: 'High', createdAt });
    expect(high.firstResponseDueAt).toBe('2026-01-01T02:00:00.000Z');
    expect(high.slaDueAt).toBe('2026-01-01T08:00:00.000Z');
  });

  it('falls back to Normal for an unknown or missing priority', () => {
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

  it('flags a first-response breach only while no response exists', () => {
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

  it('flags a resolution breach on an active ticket but not a terminal one', () => {
    const base = {
      createdAt: '2026-01-01T00:00:00.000Z',
      firstResponseAt: '2026-01-01T01:00:00.000Z',
      firstResponseDueAt: '2026-01-01T04:00:00.000Z',
      slaDueAt: '2026-01-01T06:00:00.000Z',
    };
    const now = '2026-01-01T07:00:00.000Z';

    expect(
      evaluateSlaBreach({ ...base, stage: 'In Progress' }, { now })
        .resolutionBreached,
    ).toBe(true);
    expect(
      evaluateSlaBreach({ ...base, stage: 'Resolved' }, { now })
        .resolutionBreached,
    ).toBe(false);
    expect(
      evaluateSlaBreach({ ...base, stage: 'Closed' }, { now }).isBreached,
    ).toBe(false);
  });
});

describe('ticket stage model', () => {
  it('exposes the four historical columns as canonical', () => {
    expect(KANBAN_STAGES).toEqual([
      'New',
      'In Progress',
      'Awaiting Client',
      'Resolved',
    ]);
  });

  it('treats Resolved and Closed as terminal', () => {
    expect(isTerminalStage('Resolved')).toBe(true);
    expect(isTerminalStage('Closed')).toBe(true);
    expect(isTerminalStage('New')).toBe(false);
    expect(isTerminalStage('Bogus')).toBe(false);
  });

  it('validates target stages', () => {
    expect(isValidStage('New')).toBe(true);
    expect(isValidStage('Closed')).toBe(true);
    expect(isValidStage('Shipped')).toBe(false);
    expect(isValidStage('')).toBe(false);
  });

  it('permits only declared transitions and idempotent no-ops', () => {
    expect(canTransition('New', 'In Progress')).toBe(true);
    expect(canTransition('In Progress', 'Resolved')).toBe(true);
    expect(canTransition('Resolved', 'Closed')).toBe(true);
    expect(canTransition('New', 'Closed')).toBe(false);
    expect(canTransition('Resolved', 'New')).toBe(false);
    expect(canTransition('New', 'New')).toBe(true);
    expect(canTransition('New', 'Shipped')).toBe(false);
  });

  it('omits Closed until a ticket uses it and appends unknown stages', () => {
    expect(buildStageSummary([{ stage: 'New' }])).toEqual([
      { stage: 'New', count: 1 },
      { stage: 'In Progress', count: 0 },
      { stage: 'Awaiting Client', count: 0 },
      { stage: 'Resolved', count: 0 },
    ]);

    const five = buildStageSummary([{ stage: 'New' }, { stage: 'Closed' }]);
    expect(five.map((s) => s.stage)).toEqual([
      'New',
      'In Progress',
      'Awaiting Client',
      'Resolved',
      'Closed',
    ]);
    expect(five.find((s) => s.stage === 'Closed').count).toBe(1);

    expect(buildStageSummary([{ stage: 'Escalated' }]).map((s) => s.stage)).toContain(
      'Escalated',
    );
  });
});

describe('tickets: Kanban stages and SLA over the API', () => {
  it('stamps SLA due dates and an initial history entry on create', async () => {
    const res = await createTicket({ subject: 'Create SLA', priority: 'High' });
    expect(res.status).toBe(201);
    const { id: ticketId } = res.body;

    expect(res.body.stage).toBe('New');
    expect(res.body.stageHistory).toHaveLength(1);
    expect(res.body.stageHistory[0]).toMatchObject({ stage: 'New' });
    expect(res.body.firstResponseBreached).toBe(false);
    expect(res.body.resolutionBreached).toBe(false);
    expect(res.body.isBreached).toBe(false);

    const { rows } = await query(
      'SELECT first_response_due_at, sla_due_at, sla_breached, created_at FROM tickets WHERE id = $1',
      [ticketId],
    );
    const row = rows[0];
    const created = new Date(row.created_at).getTime();
    // `created_at` is stamped by Postgres at insert time, a few milliseconds
    // after the route's now(), so compare the offsets with a small tolerance.
    const firstDelta = new Date(row.first_response_due_at).getTime() - created;
    const slaDelta = new Date(row.sla_due_at).getTime() - created;
    expect(firstDelta).toBeGreaterThan(2 * 3600000 - 5000);
    expect(firstDelta).toBeLessThanOrEqual(2 * 3600000);
    expect(slaDelta).toBeGreaterThan(8 * 3600000 - 5000);
    expect(slaDelta).toBeLessThanOrEqual(8 * 3600000);
    expect(row.sla_breached).toBe(false);
  });

  it('returns the new SLA fields on GET /api/tickets', async () => {
    const created = await createTicket({ subject: 'List SLA', priority: 'Normal' });
    const res = await auth(request(app).get('/api/tickets'));
    expect(res.status).toBe(200);

    const row = res.body.data.find((t) => t.id === created.body.id);
    expect(row).toBeTruthy();
    expect(typeof row.firstResponseDueAt).toBe('string');
    expect(typeof row.slaDueAt).toBe('string');
    expect(row.firstResponseBreached).toBe(false);
    expect(row.isBreached).toBe(false);
  });

  it('moves New -> In Progress and records the response and history', async () => {
    const created = await createTicket({ subject: 'Move to progress' });
    const ticketId = created.body.id;

    const res = await auth(request(app).put(`/api/tickets/${ticketId}`)).send({
      stage: 'In Progress',
    });
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('In Progress');
    expect(res.body.firstResponseAt).toBeTruthy();
    expect(res.body.stageHistory).toHaveLength(2);
    expect(res.body.stageHistory[1]).toMatchObject({
      from: 'New',
      stage: 'In Progress',
    });

    const { rows } = await query(
      'SELECT stage, first_response_at, stage_history FROM tickets WHERE id = $1',
      [ticketId],
    );
    expect(rows[0].stage).toBe('In Progress');
    expect(rows[0].first_response_at).toBeTruthy();
    expect(rows[0].stage_history).toHaveLength(2);
  });

  it('treats a same-stage PUT as an idempotent no-op', async () => {
    const created = await createTicket({ subject: 'No-op stage' });
    const res = await auth(request(app).put(`/api/tickets/${created.body.id}`)).send({
      stage: 'New',
    });
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('New');
    expect(res.body.stageHistory).toHaveLength(1);
  });

  it('rejects a stage that is not part of the model', async () => {
    const created = await createTicket({ subject: 'Bad stage' });
    const res = await auth(request(app).put(`/api/tickets/${created.body.id}`)).send({
      stage: 'Shipped',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stage must be one of/);

    const { rows } = await query('SELECT stage FROM tickets WHERE id = $1', [
      created.body.id,
    ]);
    expect(rows[0].stage).toBe('New');
  });

  it('rejects a disallowed transition', async () => {
    const created = await createTicket({ subject: 'Illegal jump' });
    const res = await auth(request(app).put(`/api/tickets/${created.body.id}`)).send({
      stage: 'Closed',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid stage transition/);

    const { rows } = await query('SELECT stage FROM tickets WHERE id = $1', [
      created.body.id,
    ]);
    expect(rows[0].stage).toBe('New');
  });

  it('records resolvedAt/closedAt and the full history across the lifecycle', async () => {
    const created = await createTicket({ subject: 'Full lifecycle' });
    const ticketId = created.body.id;
    const put = (stage) =>
      auth(request(app).put(`/api/tickets/${ticketId}`)).send({ stage });

    expect((await put('In Progress')).status).toBe(200);

    const resolved = await put('Resolved');
    expect(resolved.status).toBe(200);
    expect(resolved.body.resolvedAt).toBeTruthy();
    expect(resolved.body.sla.status).toBe('met');

    const closed = await put('Closed');
    expect(closed.status).toBe(200);
    expect(closed.body.stage).toBe('Closed');
    expect(closed.body.closedAt).toBeTruthy();
    expect(closed.body.resolvedAt).toBeTruthy();
    expect(closed.body.stageHistory).toHaveLength(4);

    const { rows } = await query(
      'SELECT stage, resolved_at, closed_at, stage_history FROM tickets WHERE id = $1',
      [ticketId],
    );
    expect(rows[0].stage).toBe('Closed');
    expect(rows[0].resolved_at).toBeTruthy();
    expect(rows[0].closed_at).toBeTruthy();
    expect(rows[0].stage_history.map((h) => h.stage)).toEqual([
      'New',
      'In Progress',
      'Resolved',
      'Closed',
    ]);
  });

  it('adds the Closed column to the board once a ticket is closed', async () => {
    const created = await createTicket({ subject: 'Closed column probe' });
    const ticketId = created.body.id;
    const put = (stage) =>
      auth(request(app).put(`/api/tickets/${ticketId}`)).send({ stage });
    await put('In Progress');
    await put('Resolved');
    expect((await put('Closed')).status).toBe(200);

    const res = await auth(
      request(app).get('/api/tickets?q=Closed%20column%20probe'),
    );
    expect(res.body.stages.map((s) => s.stage)).toEqual([
      'New',
      'In Progress',
      'Awaiting Client',
      'Resolved',
      'Closed',
    ]);
    expect(res.body.stages.find((s) => s.stage === 'Closed').count).toBe(1);
  });

  it('flags a first-response breach once the deadline passes, clearing on response', async () => {
    const created = await createTicket({
      subject: 'First response breach',
      priority: 'High',
    });
    const ticketId = created.body.id;
    await query(
      "UPDATE tickets SET first_response_due_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
      [ticketId],
    );

    const breached = await getTicket(ticketId);
    expect(breached.status).toBe(200);
    expect(breached.body.firstResponseBreached).toBe(true);
    expect(breached.body.resolutionBreached).toBe(false);
    expect(breached.body.isBreached).toBe(false);

    await auth(request(app).put(`/api/tickets/${ticketId}`)).send({
      stage: 'In Progress',
    });
    const after = await getTicket(ticketId);
    expect(after.body.firstResponseBreached).toBe(false);
  });

  it('recomputes a resolution breach on active tickets and clears it when terminal', async () => {
    const created = await createTicket({
      subject: 'Resolution breach',
      priority: 'High',
    });
    const ticketId = created.body.id;
    await auth(request(app).put(`/api/tickets/${ticketId}`)).send({
      stage: 'In Progress',
    });
    await query(
      "UPDATE tickets SET sla_due_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
      [ticketId],
    );

    const active = await getTicket(ticketId);
    expect(active.body.resolutionBreached).toBe(true);
    expect(active.body.isBreached).toBe(true);
    expect(active.body.slaBreached).toBe(true);

    // Read-time recomputation must not itself persist the flag.
    const beforeResolve = await query(
      'SELECT sla_breached FROM tickets WHERE id = $1',
      [ticketId],
    );
    expect(beforeResolve.rows[0].sla_breached).toBe(false);

    const resolved = await auth(request(app).put(`/api/tickets/${ticketId}`)).send({
      stage: 'Resolved',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.resolutionBreached).toBe(false);

    const afterResolve = await query(
      'SELECT sla_breached FROM tickets WHERE id = $1',
      [ticketId],
    );
    expect(afterResolve.rows[0].sla_breached).toBe(false);
  });

  it('honours page/limit/sortBy/sortDir and the envelope flag', async () => {
    for (const name of ['alpha', 'bravo', 'charlie']) {
      const res = await createTicket({ subject: `kanbanpg ${name}` });
      expect(res.status).toBe(201);
    }

    const q = 'q=kanbanpg&sortBy=subject&sortDir=asc';
    const page1 = await auth(request(app).get(`/api/tickets?${q}&page=1&limit=1`));
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(1);
    expect(page1.body.total).toBe(3);
    expect(page1.body.page).toBe(1);
    expect(page1.body.limit).toBe(1);
    expect(page1.body.totalPages).toBe(3);
    expect(page1.body.data[0].subject).toBe('kanbanpg alpha');

    const page2 = await auth(request(app).get(`/api/tickets?${q}&page=2&limit=1`));
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.data[0].subject).toBe('kanbanpg bravo');
    expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);

    const env = await auth(request(app).get('/api/tickets?q=kanbanpg&envelope=true'));
    expect(env.body.limit).toBe(20);
    expect(env.body.page).toBe(1);
    expect(env.body.total).toBe(3);
    expect(env.body.totalPages).toBe(1);
    expect(env.body.data).toHaveLength(3);

    // Bad paging input degrades to the defaults rather than returning nothing.
    const zero = await auth(
      request(app).get('/api/tickets?q=kanbanpg&envelope=true&limit=0&page=0'),
    );
    expect(zero.body.limit).toBe(20);
    expect(zero.body.page).toBe(1);
    expect(zero.body.data).toHaveLength(3);
  });

  it('keeps the legacy unpaginated envelope free of paging fields', async () => {
    const res = await auth(request(app).get('/api/tickets?q=kanbanpg'));
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('stages');
    expect(res.body).toHaveProperty('sla');
    expect(res.body.total).toBe(3);
    expect(res.body.page).toBeUndefined();
    expect(res.body.limit).toBeUndefined();
  });

  it('summarises the board with the extended SLA counters', async () => {
    const res = await auth(request(app).get('/api/tickets/sla/summary'));
    expect(res.status).toBe(200);
    expect(typeof res.body.open).toBe('number');
    expect(typeof res.body.resolved).toBe('number');
    expect(typeof res.body.breached).toBe('number');
    expect(typeof res.body.resolutionBreached).toBe('number');
    expect(res.body.firstResponseBreached).toBe(res.body.breached);
  });

  it('serves a single ticket and 404s an unknown id', async () => {
    const created = await createTicket({ subject: 'Fetch by id' });
    const res = await getTicket(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body).toHaveProperty('sla');

    const missing = await auth(request(app).get('/api/tickets/does-not-exist'));
    expect(missing.status).toBe(404);
  });

  it('does not restamp a timestamp on a partial PUT', async () => {
    const created = await createTicket({ subject: 'Partial PUT' });
    const ticketId = created.body.id;
    await auth(request(app).put(`/api/tickets/${ticketId}`)).send({
      stage: 'In Progress',
    });
    const before = await getTicket(ticketId);

    const res = await auth(request(app).put(`/api/tickets/${ticketId}`)).send({
      description: 'Still broken',
    });
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('In Progress');
    expect(res.body.firstResponseAt).toBe(before.body.firstResponseAt);
    expect(res.body.stageHistory).toHaveLength(2);
  });
});
