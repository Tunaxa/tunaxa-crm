import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resetTestDb, cleanupTestDb, seedTestUser } from './setup.js';
import { repoFor } from '../db/repositories/index.js';
import { mutateDb } from '../store.js';
import {
  calculateLeadScore,
  scoreAllLeads,
  scheduleNightlyLeadScoring,
  getLeadScoringQueue,
  closeLeadScoringQueue,
  getInMemoryLeadScoringJobs,
  clearLeadScoringQueue,
  NIGHTLY_CRON,
} from '../workers/leadScoring.js';

beforeAll(async () => {
  await resetTestDb();
  await seedTestUser();
}, 30000);

afterAll(async () => {
  await closeLeadScoringQueue();
  await cleanupTestDb();
});

beforeEach(() => {
  clearLeadScoringQueue();
});

describe('AI Lead Scoring Algorithm (calculateLeadScore)', () => {
  it('returns 0 score for inactive/cold leads with no activities and open status', () => {
    const result = calculateLeadScore({
      lead: { id: 'lead_cold_1', status: 'Open', email: 'cold@test.com' },
      activities: [],
      formSubmissions: [],
    });

    expect(result.score).toBe(0);
    expect(result.factors.emailScore).toBe(0);
    expect(result.factors.recencyScore).toBe(0);
    expect(result.factors.velocityScore).toBe(0);
    expect(result.factors.formScore).toBe(0);
  });

  it('scales email interaction points (+5 pts per email) capped at 25 points', () => {
    const oneEmail = [{ type: 'Email', date: new Date().toISOString() }];
    const res1 = calculateLeadScore({ lead: { status: 'Contacted' }, activities: oneEmail });
    expect(res1.factors.emailScore).toBe(5);

    const threeEmails = [
      { type: 'Email', date: new Date().toISOString() },
      { type: 'email', date: new Date().toISOString() },
      { type: 'Email', date: new Date().toISOString() },
    ];
    const res3 = calculateLeadScore({ lead: { status: 'Contacted' }, activities: threeEmails });
    expect(res3.factors.emailScore).toBe(15);

    const sixEmails = Array.from({ length: 6 }, () => ({
      type: 'Email',
      date: new Date().toISOString(),
    }));
    const res6 = calculateLeadScore({ lead: { status: 'Contacted' }, activities: sixEmails });
    expect(res6.factors.emailScore).toBe(25);
  });

  it('degrades activity recency points over time', () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    // <= 2 days: 25 points
    const res2d = calculateLeadScore({
      lead: { status: 'Contacted' },
      activities: [{ type: 'Call', date: new Date(now - 1 * day).toISOString() }],
    });
    expect(res2d.factors.recencyScore).toBe(25);

    // <= 7 days: 20 points
    const res7d = calculateLeadScore({
      lead: { status: 'Contacted' },
      activities: [{ type: 'Call', date: new Date(now - 5 * day).toISOString() }],
    });
    expect(res7d.factors.recencyScore).toBe(20);

    // <= 14 days: 15 points
    const res14d = calculateLeadScore({
      lead: { status: 'Contacted' },
      activities: [{ type: 'Call', date: new Date(now - 10 * day).toISOString() }],
    });
    expect(res14d.factors.recencyScore).toBe(15);

    // <= 30 days: 5 points
    const res30d = calculateLeadScore({
      lead: { status: 'Contacted' },
      activities: [{ type: 'Call', date: new Date(now - 22 * day).toISOString() }],
    });
    expect(res30d.factors.recencyScore).toBe(5);

    // > 30 days: 0 points
    const resOver30 = calculateLeadScore({
      lead: { status: 'Contacted' },
      activities: [{ type: 'Call', date: new Date(now - 45 * day).toISOString() }],
    });
    expect(resOver30.factors.recencyScore).toBe(0);
  });

  it('evaluates stage velocity weighting across lead statuses', () => {
    const sampleActivity = [{ type: 'Call', date: new Date().toISOString() }];

    const qualified = calculateLeadScore({
      lead: { status: 'Qualified' },
      activities: sampleActivity,
    });
    expect(qualified.factors.velocityScore).toBe(25);

    const contacted = calculateLeadScore({
      lead: { status: 'Contacted' },
      activities: sampleActivity,
    });
    expect(contacted.factors.velocityScore).toBe(18);

    const openWithActivity = calculateLeadScore({
      lead: { status: 'Open' },
      activities: sampleActivity,
    });
    expect(openWithActivity.factors.velocityScore).toBe(10);

    const lost = calculateLeadScore({
      lead: { status: 'Lost' },
      activities: sampleActivity,
    });
    expect(lost.factors.velocityScore).toBe(0);
  });

  it('awards form fill points (+10 pts) and clamps total score to [0, 100]', () => {
    const forms = [
      { type: 'Form', title: 'Whitepaper Form', date: new Date().toISOString() },
      { type: 'Form', title: 'Pricing Form', date: new Date().toISOString() },
    ];
    const res2Forms = calculateLeadScore({
      lead: { status: 'Open' },
      activities: forms,
    });
    expect(res2Forms.factors.formScore).toBe(20);

    // Maximum theoretical points (25 + 25 + 25 + 25 = 100)
    const maxActivities = [
      ...Array.from({ length: 5 }, () => ({ type: 'Email', date: new Date().toISOString() })),
      ...Array.from({ length: 3 }, () => ({ type: 'Form', date: new Date().toISOString() })),
    ];
    const maxResult = calculateLeadScore({
      lead: { status: 'Qualified' },
      activities: maxActivities,
    });
    expect(maxResult.score).toBe(100);
    expect(maxResult.factors.emailScore).toBe(25);
    expect(maxResult.factors.recencyScore).toBe(25);
    expect(maxResult.factors.velocityScore).toBe(25);
    expect(maxResult.factors.formScore).toBe(25);
  });
});

describe('Lead Scoring Worker & PostgreSQL Persistence', () => {
  it('processes leads, updates score and last_scored_at in PostgreSQL', async () => {
    // 1. Seed leads in PostgreSQL
    const leadHigh = await repoFor('leads').create({
      workspace_id: 'default',
      first_name: 'Diana',
      last_name: 'Prince',
      email: `diana_${Date.now()}@themyscira.test`,
      status: 'Qualified',
      value: 100000,
    });

    const leadLow = await repoFor('leads').create({
      workspace_id: 'default',
      first_name: 'Clark',
      last_name: 'Kent',
      email: `clark_${Date.now()}@dailyplanet.test`,
      status: 'Open',
      value: 5000,
    });

    const leadCold = await repoFor('leads').create({
      workspace_id: 'default',
      first_name: 'Arthur',
      last_name: 'Curry',
      email: `arthur_${Date.now()}@atlantis.test`,
      status: 'Open',
      value: 2000,
    });

    // 2. Seed activities for High and Low leads
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      await repoFor('activities').create({
        workspace_id: 'default',
        type: 'Email',
        title: `Outreach Email #${i + 1}`,
        record_id: leadHigh.id,
        contact: leadHigh.email,
        date: now,
      });
    }
    await repoFor('activities').create({
      workspace_id: 'default',
      type: 'Form',
      title: 'Demo Request Form Submission',
      record_id: leadHigh.id,
      contact: leadHigh.email,
      date: now,
    });

    // Lead Low has only 1 call 20 days ago
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await repoFor('activities').create({
      workspace_id: 'default',
      type: 'Call',
      title: 'Initial Check-in',
      record_id: leadLow.id,
      contact: leadLow.email,
      date: twentyDaysAgo,
    });

    // 3. Run lead scoring worker
    const summary = await scoreAllLeads({ threshold: 75 });
    expect(summary.totalProcessed).toBeGreaterThanOrEqual(3);
    expect(summary.scoredCount).toBeGreaterThanOrEqual(3);
    expect(summary.triggeredWorkflows).toBeGreaterThanOrEqual(1);

    // 4. Verify PostgreSQL persistence
    const updatedHigh = await repoFor('leads').findById(leadHigh.id);
    expect(updatedHigh).toBeDefined();
    expect(updatedHigh.score).toBeGreaterThanOrEqual(75);
    expect(updatedHigh.last_scored_at).toBeDefined();

    const updatedLow = await repoFor('leads').findById(leadLow.id);
    expect(updatedLow).toBeDefined();
    expect(updatedLow.score).toBeLessThan(75);
    expect(updatedLow.last_scored_at).toBeDefined();

    const updatedCold = await repoFor('leads').findById(leadCold.id);
    expect(updatedCold).toBeDefined();
    expect(updatedCold.score).toBe(0);
    expect(updatedCold.last_scored_at).toBeDefined();
  });

  it('triggers lead.scored workflow only when lead score meets or exceeds threshold', async () => {
    // 1. Configure a workflow listening for lead.scored
    await mutateDb((db) => {
      if (!Array.isArray(db.workflows)) db.workflows = [];
      db.workflows.push({
        id: 'wf_lead_scored_priority',
        name: 'High Value Lead Alert',
        enabled: true,
        event: 'lead.scored',
        actions: [
          {
            id: 'act_vip_task',
            type: 'task',
            title: 'Assign VIP Concierge for {{name}}',
            dueDate: new Date(Date.now() + 86400000).toISOString(),
          },
        ],
      });
    });

    // 2. Create lead that will easily cross threshold 80
    const vipLead = await repoFor('leads').create({
      workspace_id: 'default',
      first_name: 'Tony',
      last_name: 'Stark',
      email: `stark_${Date.now()}@avengers.test`,
      status: 'Qualified',
    });

    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      await repoFor('activities').create({
        workspace_id: 'default',
        type: 'Email',
        title: `Technical Spec #${i + 1}`,
        record_id: vipLead.id,
        contact: vipLead.email,
        date: now,
      });
    }
    await repoFor('activities').create({
      workspace_id: 'default',
      type: 'Form',
      title: 'Enterprise Inquiry',
      record_id: vipLead.id,
      contact: vipLead.email,
      date: now,
    });

    // 3. Create lead that will NOT cross threshold 80
    const regularLead = await repoFor('leads').create({
      workspace_id: 'default',
      first_name: 'Peter',
      last_name: 'Parker',
      email: `parker_${Date.now()}@queens.test`,
      status: 'Open',
    });
    await repoFor('activities').create({
      workspace_id: 'default',
      type: 'Call',
      title: 'Casual Chat',
      record_id: regularLead.id,
      contact: regularLead.email,
      date: now,
    });

    // 4. Run scoring with threshold 80
    const result = await scoreAllLeads({ threshold: 80 });
    expect(result.triggeredWorkflows).toBeGreaterThanOrEqual(1);

    // 5. Verify the VIP task was created in tasks repository
    const tasksRes = await repoFor('tasks').findAll({ limit: 100 });
    const vipTask = (tasksRes?.data || tasksRes?.items || []).find((t) =>
      t.title && t.title.includes('Tony Stark'),
    );
    expect(vipTask).toBeDefined();

    // Verify regular lead did NOT trigger a VIP task
    const regularTask = (tasksRes?.data || tasksRes?.items || []).find((t) =>
      t.title && t.title.includes('Peter Parker'),
    );
    expect(regularTask).toBeUndefined();
  });
});

describe('BullMQ Queue & Nightly Scheduler', () => {
  it('registers nightly repeatable lead scoring job with cron pattern 0 2 * * *', async () => {
    const job = await scheduleNightlyLeadScoring({ forceInMemory: true });
    expect(job).toBeDefined();
    expect(job.name).toBe('nightly-lead-scoring');
    expect(job.opts?.repeat?.pattern).toBe(NIGHTLY_CRON);

    const queue = getLeadScoringQueue({ forceInMemory: true });
    const repeatables = await queue.getRepeatableJobs();
    expect(repeatables.length).toBeGreaterThanOrEqual(1);
    expect(repeatables[0].pattern).toBe('0 2 * * *');

    const inMemoryJobs = getInMemoryLeadScoringJobs();
    expect(inMemoryJobs.length).toBeGreaterThanOrEqual(1);
  });

  it('handles in-memory queue fallback cleanly without Redis connection', async () => {
    const queue = getLeadScoringQueue({ forceInMemory: true });
    expect(queue).toBeDefined();
    expect(typeof queue.add).toBe('function');

    const testJob = await queue.add('test-scoring-task', { test: true });
    expect(testJob.id).toBeDefined();
    expect(testJob.name).toBe('test-scoring-task');

    await closeLeadScoringQueue();
  });
});
