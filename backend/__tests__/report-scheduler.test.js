import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import supertest from 'supertest';
import { app } from '../server.js';
import { resetTestDb, cleanupTestDb } from './setup.js';
import { query } from '../db/pg.js';
import { mutateDb, readDb } from '../store.js';
import {
  generateReportEmailContent,
  summarizeReportData,
  escapeHtml,
} from '../services/reportEmail.js';
import {
  normalizeReportSchedule,
  isScheduleActive,
  isScheduleDue,
  WEEKDAYS,
} from '../services/reports.js';
import { createSavedReport } from '../services/savedReports.js';
import {
  runScheduledReports,
  scheduleWeeklyReports,
  getReportSchedulerQueue,
  generateReportData,
  clearReportSchedulerQueue,
  closeReportSchedulerQueue,
  getInMemoryReportSchedulerJobs,
  InMemoryReportSchedulerQueue,
  QUEUE_NAME,
  WEEKLY_CRON,
  WEEKLY_JOB_NAME,
} from '../workers/reportScheduler.js';

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

/** A Monday at 08:00 UTC - the slot the cron `0 8 * * 1` fires on. */
function mondayMorning() {
  const date = new Date();
  const offset = (8 - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + offset);
  date.setUTCHours(8, 0, 0, 0);
  return date;
}

/** A Tuesday at 08:00 UTC - the slot the cron deliberately skips. */
function tuesdayMorning() {
  const monday = mondayMorning();
  monday.setUTCDate(monday.getUTCDate() + 1);
  return monday;
}

async function seedDeals(rows) {
  try {
    for (const row of rows) {
      await query(
        `INSERT INTO deals (workspace_id, title, value, stage, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [row.workspace_id, row.title, row.value, row.stage, row.created_at || new Date().toISOString()],
      );
    }
  } catch {
    await mutateDb((db) => {
      for (const row of rows) db.deals.push(row);
    });
  }
}

async function createReport(token, overrides = {}) {
  const res = await supertest(app)
    .post('/api/reports')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'Weekly Pipeline Summary',
      entity: 'deals',
      query: { entity: 'deals', groupBy: 'stage', metric: 'sum', field: 'value' },
      ...overrides,
    });
  expect(res.status).toBe(201);
  return res.body;
}

async function setSchedule(token, reportId, schedule) {
  return await supertest(app)
    .put(`/api/reports/${reportId}/schedule`)
    .set('Authorization', `Bearer ${token}`)
    .send(schedule);
}

beforeAll(async () => {
  await resetTestDb();

  await mutateDb((db) => {
    db.users.push(
      {
        id: 'usr_admin',
        name: 'Admin User',
        email: 'admin@schedulertest.com',
        password: makePassword(),
        role: 'admin',
        workspaceId: 'default',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'usr_member',
        name: 'Member User',
        email: 'member@schedulertest.com',
        password: makePassword(),
        role: 'member',
        workspaceId: 'default',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'usr_viewer',
        name: 'Viewer User',
        email: 'viewer@schedulertest.com',
        password: makePassword(),
        role: 'viewer',
        workspaceId: 'default',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'usr_acme',
        name: 'Acme Admin',
        email: 'acme@schedulertest.com',
        password: makePassword(),
        role: 'admin',
        workspaceId: 'ws_acme',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'usr_globex',
        name: 'Globex Admin',
        email: 'globex@schedulertest.com',
        password: makePassword(),
        role: 'admin',
        workspaceId: 'ws_globex',
        createdAt: new Date().toISOString(),
      }
    );
  });

  adminToken = await login('admin@schedulertest.com');
  memberToken = await login('member@schedulertest.com');
  viewerToken = await login('viewer@schedulertest.com');
  acmeToken = await login('acme@schedulertest.com');
  globexToken = await login('globex@schedulertest.com');

  await seedDeals([
    { workspace_id: 'default', title: 'Deal Alpha', value: 10000, stage: 'Proposal', created_at: '2026-03-01T10:00:00Z' },
    { workspace_id: 'default', title: 'Deal Beta', value: 20000, stage: 'Proposal', created_at: '2026-03-02T10:00:00Z' },
    { workspace_id: 'default', title: 'Deal Gamma', value: 30000, stage: 'Negotiation', created_at: '2026-03-05T10:00:00Z' },
    { workspace_id: 'default', title: 'Deal Delta', value: 50000, stage: 'Won', created_at: '2026-03-10T10:00:00Z' },
    { workspace_id: 'default', title: 'Deal Epsilon', value: 100000, stage: 'Won', created_at: '2026-03-12T10:00:00Z' },
    { workspace_id: 'ws_acme', title: 'Acme Deal 1', value: 75000, stage: 'Won', created_at: '2026-03-11T10:00:00Z' },
    { workspace_id: 'ws_acme', title: 'Acme Deal 2', value: 25000, stage: 'Won', created_at: '2026-03-12T10:00:00Z' },
    { workspace_id: 'ws_globex', title: 'Globex Giant Deal', value: 1000000, stage: 'Won', created_at: '2026-03-13T10:00:00Z' },
  ]);
}, 30000);

afterAll(async () => {
  await closeReportSchedulerQueue();
  await cleanupTestDb();
});

beforeEach(() => {
  clearReportSchedulerQueue();
  mutateDb((db) => {
    db.messages = [];
    db.notifications = [];
  });
});

describe('1. Report Schedule Configuration API (PUT /api/reports/:id/schedule)', () => {
  it('rejects unauthenticated requests with 401 Unauthorized', async () => {
    const report = await createReport(adminToken);
    const res = await supertest(app).put(`/api/reports/${report.id}/schedule`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('rejects the viewer role with 403 Forbidden', async () => {
    const report = await createReport(adminToken);
    const res = await setSchedule(viewerToken, report.id, {
      enabled: true,
      recipients: ['sales@company.com'],
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden');
  });

  it('allows a member to configure and persist a weekly schedule', async () => {
    const report = await createReport(memberToken);

    const res = await setSchedule(memberToken, report.id, {
      enabled: true,
      frequency: 'weekly',
      dayOfWeek: 'monday',
      time: '08:00',
      recipients: ['sales-team@company.com', 'exec@company.com'],
      format: 'summary',
      includeTable: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.schedule).toMatchObject({
      enabled: true,
      frequency: 'weekly',
      dayOfWeek: 'monday',
      time: '08:00',
      format: 'summary',
      includeTable: true,
    });
    expect(res.body.schedule.recipients).toEqual([
      'sales-team@company.com',
      'exec@company.com',
    ]);
    expect(res.body.schedule.lastSentAt).toBeNull();

    // Read back through the dedicated endpoint.
    const readBack = await supertest(app)
      .get(`/api/reports/${report.id}/schedule`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(readBack.status).toBe(200);
    expect(readBack.body.active).toBe(true);
    expect(readBack.body.schedule.recipients).toContain('exec@company.com');
  });

  it('rejects invalid recipient email addresses with 400 Bad Request', async () => {
    const report = await createReport(adminToken);

    for (const bad of ['not-an-email', 'missing@domain', 'two@@at.com', '@company.com', 'spaced out@x.com']) {
      const res = await setSchedule(adminToken, report.id, {
        enabled: true,
        recipients: [bad],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid recipient email address');
    }
  });

  it('rejects a non-array recipients payload with 400', async () => {
    const report = await createReport(adminToken);
    const res = await setSchedule(adminToken, report.id, {
      enabled: true,
      recipients: 'sales@company.com',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('must be an array');
  });

  it('rejects a non-weekly frequency with 400', async () => {
    const report = await createReport(adminToken);
    const res = await setSchedule(adminToken, report.id, {
      enabled: true,
      frequency: 'daily',
      recipients: ['sales@company.com'],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid schedule frequency');
  });

  it('rejects an unknown dayOfWeek and a malformed time with 400', async () => {
    const report = await createReport(adminToken);

    const badDay = await setSchedule(adminToken, report.id, { dayOfWeek: 'caturday' });
    expect(badDay.status).toBe(400);
    expect(badDay.body.error).toContain('Invalid schedule dayOfWeek');

    const badTime = await setSchedule(adminToken, report.id, { time: '25:99' });
    expect(badTime.status).toBe(400);
    expect(badTime.body.error).toContain('Invalid schedule time');
  });

  it('requires at least one recipient when enabling a schedule', async () => {
    const report = await createReport(adminToken);
    const res = await setSchedule(adminToken, report.id, { enabled: true, recipients: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('At least one recipient');
  });

  it('can disable a schedule without dropping the configured recipients', async () => {
    const report = await createReport(adminToken);
    await setSchedule(adminToken, report.id, {
      enabled: true,
      recipients: ['sales@company.com'],
    });

    const res = await setSchedule(adminToken, report.id, { enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.schedule.enabled).toBe(false);
    expect(res.body.schedule.recipients).toEqual(['sales@company.com']);
  });

  it('persists a schedule supplied at report creation time', async () => {
    const res = await supertest(app)
      .post('/api/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Created With Schedule',
        query: { entity: 'deals', groupBy: 'stage', metric: 'count' },
        schedule: { enabled: true, recipients: ['cfo@company.com'] },
      });

    expect(res.status).toBe(201);
    expect(res.body.schedule.enabled).toBe(true);
    expect(res.body.schedule.recipients).toEqual(['cfo@company.com']);
    expect(res.body.schedule.frequency).toBe('weekly');
    expect(res.body.schedule.dayOfWeek).toBe('monday');
  });

  it('returns 404 when scheduling a report that does not exist', async () => {
    const res = await setSchedule(adminToken, 'rpt_does_not_exist', { enabled: false });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Report not found');
  });
});

describe('2. Email Digest Generation (reportEmail service)', () => {
  const report = {
    id: 'rpt_digest',
    name: 'Weekly Pipeline Summary',
    entity: 'deals',
    query: { entity: 'deals', groupBy: 'stage', metric: 'sum', field: 'value' },
    schedule: { enabled: true, recipients: ['exec@company.com'], includeTable: true },
  };
  const rows = [
    { group: 'Won', value: 150000, count: 2 },
    { group: 'Negotiation', value: 30000, count: 1 },
    { group: 'Proposal', value: 30000, count: 2 },
  ];

  it('summarizes total count, total value and average across groups', () => {
    const metrics = summarizeReportData(report, rows);

    expect(metrics.totalCount).toBe(5);
    expect(metrics.totalValue).toBe(210000);
    expect(metrics.groupCount).toBe(3);
    expect(metrics.averageValue).toBe(70000);
    expect(metrics.topGroup).toEqual({ group: 'Won', value: 150000, count: 2 });
    expect(metrics.currency).toBe(true);
  });

  it('renders an HTML table with the expected headers and formatted rows', () => {
    const { subject, html } = generateReportEmailContent(report, rows, {
      generatedAt: new Date('2026-03-16T08:00:00.000Z'),
      currency: 'USD',
      workspaceName: 'Acme',
    });

    expect(subject).toBe('Weekly Report: Weekly Pipeline Summary - 5 records');

    for (const header of ['Group / Category', 'Value / Total', 'Count', '% of Total']) {
      expect(html).toContain(header);
    }

    expect(html).toContain('Tunaxa CRM');
    expect(html).toContain('Weekly Pipeline Summary');
    expect(html).toContain('Acme');

    // $150,000.00 of $210,000.00 is 71.4% of the total.
    expect(html).toContain('$150,000.00');
    expect(html).toContain('71.4%');
    expect(html).toContain('Negotiation');
    expect(html).toContain('14.3%');
    expect(html).toContain('Total Records');
    expect(html).toContain('>5<');

    // Alternating row shading and right-aligned numerics.
    expect(html).toContain('#f9fafb');
    expect(html).toMatch(/align="right"/);
  });

  it('renders a plaintext fallback with the same metrics', () => {
    const { text } = generateReportEmailContent(report, rows, {
      generatedAt: new Date('2026-03-16T08:00:00.000Z'),
    });

    expect(text).toContain('Tunaxa CRM - Weekly Report');
    expect(text).toContain('Report:     Weekly Pipeline Summary');
    expect(text).toContain('Total Records:      5');
    expect(text).toContain('Group / Category');
    expect(text).toContain('Won');
    expect(text).toContain('71.4%');
  });

  it('handles an empty aggregation with an empty-state notice instead of a table', () => {
    const { html, text, metrics } = generateReportEmailContent(report, []);

    expect(metrics.totalCount).toBe(0);
    expect(metrics.totalValue).toBe(0);
    expect(metrics.groupCount).toBe(0);
    expect(metrics.topGroup).toBeNull();
    expect(html).toContain('No records matched this report');
    expect(html).not.toContain('% of Total');
    expect(text).toContain('No records matched this report');
  });

  it('omits the table when schedule.includeTable is false', () => {
    const { html } = generateReportEmailContent(
      { ...report, schedule: { ...report.schedule, includeTable: false } },
      rows,
    );
    expect(html).not.toContain('Group / Category');
    expect(html).toContain('Total Records');
  });

  it('escapes HTML in group labels and report names', () => {
    const { html } = generateReportEmailContent(
      { ...report, name: '<script>alert(1)</script>' },
      [{ group: '<img src=x onerror=y>', value: 1, count: 1 }],
    );

    expect(escapeHtml('<b>&"')).toBe('&lt;b&gt;&amp;&quot;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=y&gt;');
  });
});

describe('3. BullMQ Repeatable Job Configuration', () => {
  it('registers a weekly repeatable job with cron pattern 0 8 * * 1', async () => {
    expect(QUEUE_NAME).toBe('report-scheduler-queue');
    expect(WEEKLY_CRON).toBe('0 8 * * 1');

    const job = await scheduleWeeklyReports({ forceInMemory: true });
    expect(job.name).toBe(WEEKLY_JOB_NAME);
    expect(job.opts?.repeat?.pattern).toBe('0 8 * * 1');

    const queue = getReportSchedulerQueue({ forceInMemory: true });
    const repeatables = await queue.getRepeatableJobs();
    expect(repeatables.length).toBeGreaterThanOrEqual(1);
    expect(repeatables[0].pattern).toBe('0 8 * * 1');

    expect(getInMemoryReportSchedulerJobs().length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the in-memory queue with no Redis socket errors', async () => {
    const queue = getReportSchedulerQueue({ forceInMemory: true });
    expect(queue).toBeInstanceOf(InMemoryReportSchedulerQueue);
    expect(queue.name).toBe('report-scheduler-queue');

    const testJob = await queue.add('test-report-task', { test: true });
    expect(testJob.id).toBeDefined();
    expect(testJob.name).toBe('test-report-task');
  });
});

describe('4. Scheduler Execution (runScheduledReports)', () => {
  it('generates the report, emails every recipient and stamps lastSentAt', async () => {
    const report = await createReport(adminToken, { name: 'Pipeline Weekly' });
    await setSchedule(adminToken, report.id, {
      enabled: true,
      frequency: 'weekly',
      dayOfWeek: 'monday',
      time: '08:00',
      recipients: ['sales-team@company.com', 'exec@company.com'],
    });

    const before = await supertest(app)
      .get(`/api/reports/${report.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(before.body.schedule.lastSentAt).toBeNull();

    const runAt = mondayMorning();
    const summary = await runScheduledReports({
      workspaceId: 'default',
      reportId: report.id,
      now: runAt,
    });

    expect(summary.errors).toEqual([]);
    expect(summary.processedReports).toBe(1);
    expect(summary.emailsSent).toBe(2);

    // Every recipient has a logged outbound message and a notification.
    const db = await readDb();
    const toAddresses = db.messages.filter((m) => m.reportId === report.id).map((m) => m.to);
    expect(toAddresses.sort()).toEqual(['exec@company.com', 'sales-team@company.com']);
    for (const message of db.messages.filter((m) => m.reportId === report.id)) {
      expect(message.channel).toBe('email');
      expect(message.direction).toBe('Outbound');
      expect(message.subject).toContain('Pipeline Weekly');
      expect(message.html).toContain('Total Records');
      expect(message.body).toContain('Tunaxa CRM');
    }
    const notifAddresses = db.notifications
      .filter((n) => n.reportId === report.id)
      .map((n) => n.recipientEmail);
    expect(notifAddresses.sort()).toEqual(['exec@company.com', 'sales-team@company.com']);

    // schedule.lastSentAt is persisted.
    const after = await supertest(app)
      .get(`/api/reports/${report.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(after.body.schedule.lastSentAt).toBe(runAt.toISOString());
    expect(after.body.lastSentAt).toBe(runAt.toISOString());
  });

  it('skips reports whose schedule is disabled', async () => {
    const report = await createReport(adminToken, { name: 'Disabled Schedule' });
    await setSchedule(adminToken, report.id, {
      enabled: false,
      recipients: ['nobody@company.com'],
    });

    const summary = await runScheduledReports({
      workspaceId: 'default',
      reportId: report.id,
      now: mondayMorning(),
    });

    const db = await readDb();
    expect(db.messages.filter((m) => m.reportId === report.id)).toHaveLength(0);

    const after = await supertest(app)
      .get(`/api/reports/${report.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(after.body.schedule.lastSentAt).toBeNull();
    expect(summary.processedReports).toBe(0);
    expect(summary.emailsSent).toBe(0);
  });

  it('skips a schedule that is enabled but has no recipients', async () => {
    // The API refuses to enable a schedule without recipients, so this record
    // is written straight through the service to prove the worker defends
    // itself against a schedule that lost its recipients after the fact.
    const orphan = await createSavedReport(
      {
        name: 'Orphaned Schedule',
        entity: 'deals',
        query: { entity: 'deals', groupBy: 'stage', metric: 'count' },
        schedule: { enabled: true, frequency: 'weekly', dayOfWeek: 'monday', recipients: [] },
      },
      'default',
    );

    const summary = await runScheduledReports({
      workspaceId: 'default',
      reportId: orphan.id,
      now: mondayMorning(),
    });

    const db = await readDb();
    expect(db.messages.filter((m) => m.reportId === orphan.id)).toHaveLength(0);
    expect(summary.errors).toEqual([]);
    expect(summary.emailsSent).toBe(0);
  });

  it('processes every due schedule in a workspace in a single run', async () => {
    const first = await createReport(adminToken, { name: 'Batch Report A' });
    await setSchedule(adminToken, first.id, {
      enabled: true,
      recipients: ['batch-a@company.com'],
    });
    const second = await createReport(memberToken, { name: 'Batch Report B' });
    await setSchedule(memberToken, second.id, {
      enabled: true,
      recipients: ['batch-b@company.com', 'batch-c@company.com'],
    });

    const summary = await runScheduledReports({ workspaceId: 'default', now: mondayMorning() });

    expect(summary.processedReports).toBeGreaterThanOrEqual(2);
    expect(summary.emailsSent).toBeGreaterThanOrEqual(3);

    const db = await readDb();
    expect(db.messages.filter((m) => m.reportId === first.id)).toHaveLength(1);
    expect(db.messages.filter((m) => m.reportId === second.id)).toHaveLength(2);
  });

  it('holds off on a weekly schedule outside its dayOfWeek', async () => {
    const report = await createReport(adminToken, { name: 'Monday Only' });
    await setSchedule(adminToken, report.id, {
      enabled: true,
      dayOfWeek: 'monday',
      recipients: ['ops@company.com'],
    });

    const summary = await runScheduledReports({
      workspaceId: 'default',
      reportId: report.id,
      now: tuesdayMorning(),
    });
    expect(summary.emailsSent).toBe(0);
    expect(summary.processedReports).toBe(0);

    const db = await readDb();
    expect(db.messages.filter((m) => m.reportId === report.id)).toHaveLength(0);

    // force:true (used by send-now) bypasses the weekday gate.
    const forced = await runScheduledReports({
      workspaceId: 'default',
      reportId: report.id,
      force: true,
      now: tuesdayMorning(),
    });
    expect(forced.emailsSent).toBe(1);
  });

  it('isScheduleDue matches only the configured weekday', () => {
    const schedule = normalizeReportSchedule({
      enabled: true,
      dayOfWeek: 'monday',
      recipients: ['a@company.com'],
    }).schedule;

    expect(isScheduleActive(schedule)).toBe(true);
    expect(isScheduleDue(schedule, mondayMorning())).toBe(true);
    expect(isScheduleDue(schedule, tuesdayMorning())).toBe(false);
    expect(isScheduleDue({ ...schedule, enabled: false }, mondayMorning())).toBe(false);
    expect(isScheduleDue({ ...schedule, recipients: [] }, mondayMorning())).toBe(false);
    expect(WEEKDAYS[1]).toBe('monday');
  });
});

describe('5. On-Demand Delivery (POST /api/reports/:id/send-now)', () => {
  it('delivers the digest immediately and returns 200 with delivery confirmation', async () => {
    const report = await createReport(adminToken, { name: 'Send Now Report' });
    await setSchedule(adminToken, report.id, {
      enabled: true,
      recipients: ['leadership@company.com'],
    });

    const res = await supertest(app)
      .post(`/api/reports/${report.id}/send-now`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.emailsSent).toBe(1);
    expect(res.body.recipients).toEqual(['leadership@company.com']);
    expect(res.body.lastSentAt).not.toBeNull();
    expect(res.body.message).toContain('emailed to 1 recipient');

    const db = await readDb();
    const sent = db.messages.filter((m) => m.reportId === report.id);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('leadership@company.com');
    expect(sent[0].html).toContain('Send Now Report');
  });

  it('requires auth, RBAC and an active schedule', async () => {
    const report = await createReport(adminToken, { name: 'No Schedule Report' });

    const unauth = await supertest(app).post(`/api/reports/${report.id}/send-now`);
    expect(unauth.status).toBe(401);

    const forbidden = await supertest(app)
      .post(`/api/reports/${report.id}/send-now`)
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(forbidden.status).toBe(403);

    const unscheduled = await supertest(app)
      .post(`/api/reports/${report.id}/send-now`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(unscheduled.status).toBe(400);
    expect(unscheduled.body.error).toContain('no active email schedule');

    const missing = await supertest(app)
      .post('/api/reports/rpt_missing/send-now')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(missing.status).toBe(404);
  });

  it('aggregates report rows on demand through POST /api/reports/:id/run', async () => {
    const report = await createReport(adminToken, { name: 'Run Only' });
    const res = await supertest(app)
      .post(`/api/reports/${report.id}/run`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    const won = res.body.data.find((row) => row.group === 'Won');
    expect(won.value).toBe(150000);
    expect(won.count).toBe(2);
  });
});

describe('6. Workspace Tenant Isolation', () => {
  it('keeps Acme data and recipients inside ws_acme', async () => {
    const acmeReport = await createReport(acmeToken, { name: 'Acme Pipeline' });
    await setSchedule(acmeToken, acmeReport.id, {
      enabled: true,
      recipients: ['acme-leads@acme.test'],
    });

    const rows = await generateReportData(acmeReport);
    const won = rows.find((row) => row.group === 'Won');
    expect(won.value).toBe(100000); // 75000 + 25000, never the Globex 1000000
    expect(won.count).toBe(2);

    const summary = await runScheduledReports({
      workspaceId: 'ws_acme',
      reportId: acmeReport.id,
      now: mondayMorning(),
    });
    expect(summary.processedReports).toBe(1);
    expect(summary.emailsSent).toBe(1);

    const db = await readDb();
    const acmeMessages = db.messages.filter((m) => m.reportId === acmeReport.id);
    expect(acmeMessages).toHaveLength(1);
    expect(acmeMessages[0].to).toBe('acme-leads@acme.test');
    expect(acmeMessages[0].html).toContain('$100,000.00');
    expect(acmeMessages[0].html).not.toContain('$1,000,000.00');

    // No Globex or default-workspace report was delivered.
    expect(db.messages.filter((m) => m.workspaceId === 'ws_globex')).toHaveLength(0);
  });

  it('does not expose another workspace saved report', async () => {
    const acmeReport = await createReport(acmeToken, { name: 'Acme Secret' });

    const crossTenant = await supertest(app)
      .get(`/api/reports/${acmeReport.id}`)
      .set('Authorization', `Bearer ${globexToken}`);
    expect(crossTenant.status).toBe(404);

    const list = await supertest(app)
      .get('/api/reports')
      .set('Authorization', `Bearer ${globexToken}`);
    expect(list.status).toBe(200);
    expect(list.body.map((r) => r.id)).not.toContain(acmeReport.id);

    const crossSchedule = await setSchedule(globexToken, acmeReport.id, { enabled: true });
    expect(crossSchedule.status).toBe(404);
  });
});
