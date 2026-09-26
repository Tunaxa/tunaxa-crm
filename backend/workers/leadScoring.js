import { Queue, Worker } from 'bullmq';
import { readDb, mutateDb } from '../store.js';
import { repoFor } from '../db/repositories/index.js';
import { pgToLegacy } from '../db/legacy-shape.js';
import { triggerWorkflows } from '../services/workflows.js';

export const QUEUE_NAME = 'lead-scoring-queue';
export const NIGHTLY_CRON = '0 2 * * *';

export function getRedisConnection() {
  if (process.env.REDIS_URL) {
    return { url: process.env.REDIS_URL };
  }
  if (process.env.REDIS_HOST || process.env.REDIS_PORT) {
    return {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT) || 6379,
    };
  }
  if (process.env.REDIS_ENABLED === 'true') {
    return { url: 'redis://127.0.0.1:6380' };
  }
  return null;
}

/**
 * Calculates a normalized 0–100 score for a lead across 4 dimensions:
 * 1. Email Interactions (0–25 points)
 * 2. Activity Recency (0–25 points)
 * 3. Stage Velocity (0–25 points)
 * 4. Form Fills & Inbound Intent (0–25 points)
 *
 * @param {object} params
 * @param {object} params.lead - Lead record
 * @param {Array} [params.activities] - Activities matching the lead
 * @param {Array} [params.formSubmissions] - Direct form submissions
 * @returns {{ score: number, factors: { emailScore: number, recencyScore: number, velocityScore: number, formScore: number } }}
 */
export function calculateLeadScore({ lead = {}, activities = [], formSubmissions = [] } = {}) {
  // 1. Email Interactions (0–25 points)
  // +5 points per interaction, capped at 25 points (5+ interactions)
  const emailActivities = activities.filter((a) => {
    const t = String(a.type || a.channel || '').trim().toLowerCase();
    return t === 'email';
  });
  const emailScore = Math.min(25, emailActivities.length * 5);

  // 2. Activity Recency (0–25 points)
  // Measure days since the most recent activity across all activity types:
  // <= 2 days: 25 points
  // <= 7 days: 20 points
  // <= 14 days: 15 points
  // <= 30 days: 5 points
  // > 30 days or no activities: 0 points
  let recencyScore = 0;
  if (activities.length > 0) {
    const now = Date.now();
    let minDays = Infinity;
    for (const a of activities) {
      const rawDate = a.created_at || a.createdAt || a.date || a.timestamp || a.updated_at || a.updatedAt;
      if (!rawDate) continue;
      const d = new Date(rawDate).getTime();
      if (!isNaN(d)) {
        const days = (now - d) / (1000 * 60 * 60 * 24);
        if (days < minDays) {
          minDays = days;
        }
      }
    }
    if (minDays !== Infinity) {
      if (minDays <= 2) {
        recencyScore = 25;
      } else if (minDays <= 7) {
        recencyScore = 20;
      } else if (minDays <= 14) {
        recencyScore = 15;
      } else if (minDays <= 30) {
        recencyScore = 5;
      } else {
        recencyScore = 0;
      }
    }
  }

  // 3. Stage Velocity (0–25 points)
  // Evaluate advancement through lifecycle stages based on lead.status / lead.lifecycleStage:
  // - Qualified / Proposal / Customer: 25 points
  // - Contacted / In Progress: 18 points
  // - Open / New: 10 points (0 points if completely cold with no activities or form submissions)
  // - Unqualified / Lost: 0 points
  const rawStatus = String(lead.status || lead.lifecycleStage || lead.stage || '').trim().toLowerCase();
  let velocityScore = 0;

  const isQualifiedGroup = ['qualified', 'proposal', 'customer', 'won', 'sales qualified', 'sql'].includes(rawStatus);
  const isContactedGroup = ['contacted', 'in progress', 'in_progress', 'working', 'mql', 'marketing qualified'].includes(rawStatus);
  const isOpenGroup = ['open', 'new', 'draft', 'unassigned', 'lead'].includes(rawStatus) || !rawStatus;
  const isLostGroup = ['unqualified', 'lost', 'disqualified', 'junk', 'archived'].includes(rawStatus);

  const hasActivity = activities.length > 0 || (Array.isArray(formSubmissions) && formSubmissions.length > 0);

  if (isQualifiedGroup) {
    velocityScore = 25;
  } else if (isContactedGroup) {
    velocityScore = 18;
  } else if (isOpenGroup) {
    // Inactive / cold lead with no activities receives 0 velocity points
    velocityScore = hasActivity ? 10 : 0;
  } else if (isLostGroup) {
    velocityScore = 0;
  } else {
    velocityScore = hasActivity ? 10 : 0;
  }

  // Bonus / penalty for creation age vs. progress
  const rawCreated = lead.created_at || lead.createdAt;
  if (rawCreated) {
    const createdTime = new Date(rawCreated).getTime();
    if (!isNaN(createdTime)) {
      const ageDays = (Date.now() - createdTime) / (1000 * 60 * 60 * 24);
      if (isQualifiedGroup && ageDays <= 14) {
        velocityScore = 25;
      } else if (isContactedGroup && ageDays <= 7) {
        velocityScore = Math.min(25, velocityScore + 2);
      } else if (isOpenGroup && ageDays > 30 && hasActivity) {
        velocityScore = Math.max(0, velocityScore - 5);
      }
    }
  }
  velocityScore = Math.min(25, Math.max(0, velocityScore));

  // 4. Form Fills & Inbound Intent (0–25 points)
  // +10 points per form submission, capped at 25 points
  const formActivities = activities.filter((a) => {
    const t = String(a.type || '').trim().toLowerCase();
    const title = String(a.title || '').toLowerCase();
    const notes = String(a.notes || a.description || '').toLowerCase();
    return t === 'form' || title.includes('form') || notes.includes('form');
  });
  const totalFormFills = formActivities.length + (Array.isArray(formSubmissions) ? formSubmissions.length : 0);
  const formScore = Math.min(25, totalFormFills * 10);

  // 5. Score Normalization: clamped to [0, 100]
  const rawScore = emailScore + recencyScore + velocityScore + formScore;
  const score = Math.min(100, Math.max(0, Math.round(rawScore)));

  return {
    score,
    factors: {
      emailScore,
      recencyScore,
      velocityScore,
      formScore,
    },
  };
}

class InMemoryLeadScoringQueue {
  constructor(name) {
    this.name = name;
    this.jobs = [];
    this.repeatableJobs = [];
    this._counter = 1;
  }

  async add(name, data, opts = {}) {
    const job = {
      id: `lead_score_job_${this._counter++}_${Date.now()}`,
      name,
      data: data || {},
      opts: opts || {},
      timestamp: Date.now(),
    };
    if (opts.repeat) {
      this.repeatableJobs.push({
        key: name,
        name,
        pattern: opts.repeat.pattern || opts.repeat.cron,
        every: opts.repeat.every,
        data,
      });
    }
    this.jobs.push(job);
    return job;
  }

  async getRepeatableJobs() {
    return [...this.repeatableJobs];
  }

  async removeRepeatableByKey(key) {
    this.repeatableJobs = this.repeatableJobs.filter((j) => j.key !== key);
  }

  getJobs() {
    return [...this.jobs];
  }

  clear() {
    this.jobs = [];
    this.repeatableJobs = [];
  }

  async close() {
    this.jobs = [];
    this.repeatableJobs = [];
  }
}

let bullQueue = null;
let inMemoryQueue = null;
let worker = null;

export function getLeadScoringQueue({ forceInMemory = false } = {}) {
  const connection = getRedisConnection();
  if (!connection || forceInMemory) {
    if (!inMemoryQueue) {
      inMemoryQueue = new InMemoryLeadScoringQueue(QUEUE_NAME);
    }
    return inMemoryQueue;
  }

  if (!bullQueue) {
    bullQueue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
  }
  return bullQueue;
}

/**
 * Iterates through leads, calculates activity- and velocity-weighted scores,
 * updates each lead record in PostgreSQL, and triggers lead.scored workflows.
 *
 * @param {object} [options]
 * @param {string} [options.workspaceId] - Tenant workspace ID
 * @param {number} [options.threshold=70] - Threshold for triggering lead.scored workflows
 * @param {number} [options.batchSize=100] - Batch size for processing
 * @returns {Promise<{ totalProcessed: number, scoredCount: number, triggeredWorkflows: number, averageScore: number }>}
 */
export async function scoreAllLeads({
  workspaceId,
  threshold = 70,
  batchSize = 100,
} = {}) {
  let leadsToProcess = [];
  const leadsRepo = repoFor('leads');

  if (leadsRepo && typeof leadsRepo.findAll === 'function') {
    let page = 1;
    while (true) {
      const res = await leadsRepo.findAll({ page, limit: batchSize });
      const items = res?.data || res?.items || [];
      if (!items.length) break;
      leadsToProcess.push(...items);
      if (leadsToProcess.length >= (res.total || items.length)) break;
      page++;
    }
  }

  if (workspaceId && leadsToProcess.length) {
    leadsToProcess = leadsToProcess.filter(
      (l) => (l.workspace_id || l.workspaceId || 'default') === workspaceId,
    );
  }

  // Fallback to store if repository returned empty
  if (!leadsToProcess.length) {
    try {
      const db = await readDb();
      leadsToProcess = (db.leads || []).filter(
        (l) => !workspaceId || (l.workspace_id || l.workspaceId || 'default') === workspaceId,
      );
    } catch (_) {}
  }

  let scoredCount = 0;
  let triggeredWorkflows = 0;
  let totalScore = 0;

  const activitiesRepo = repoFor('activities');

  for (const lead of leadsToProcess) {
    // 1. Collate activities for lead
    let activities = [];
    if (activitiesRepo && typeof activitiesRepo.findAll === 'function') {
      try {
        const actRes = await activitiesRepo.findAll({
          recordId: lead.id,
          contact: lead.email,
          limit: 100,
        });
        activities = actRes?.data || actRes?.items || [];
      } catch (_) {}
    }

    try {
      const db = await readDb();
      const localActs = (db.activities || []).filter(
        (a) =>
          a.recordId === lead.id ||
          a.record_id === lead.id ||
          (lead.email && a.contact && a.contact.toLowerCase() === String(lead.email).toLowerCase()),
      );
      const seenIds = new Set(activities.map((a) => a.id));
      for (const act of localActs) {
        if (!seenIds.has(act.id)) activities.push(act);
      }
    } catch (_) {}

    // 2. Calculate score
    const { score, factors } = calculateLeadScore({ lead, activities });
    const previousScore = lead.score !== undefined ? lead.score : (lead.custom_fields?.score ?? null);
    const nowIso = new Date().toISOString();

    const existingCustom =
      typeof lead.custom_fields === 'object' && lead.custom_fields !== null
        ? lead.custom_fields
        : typeof lead.custom_fields === 'string'
        ? JSON.parse(lead.custom_fields || '{}')
        : {};

    const updatedCustom = {
      ...existingCustom,
      score,
      lead_score: score,
      score_factors: factors,
      last_scored_at: nowIso,
    };

    // 3. Persist score to PostgreSQL lead record
    let updatedLead = null;
    if (leadsRepo && typeof leadsRepo.update === 'function') {
      try {
        const updatedRow = await leadsRepo.update(lead.id, {
          score,
          last_scored_at: nowIso,
          custom_fields: updatedCustom,
        });
        if (updatedRow) {
          updatedLead = pgToLegacy(updatedRow, 'leads');
          updatedLead.score = score;
          updatedLead.last_scored_at = nowIso;
        }
      } catch (_) {}
    }

    if (!updatedLead) {
      await mutateDb((db) => {
        const l = (db.leads || []).find((x) => x.id === lead.id);
        if (l) {
          l.score = score;
          l.leadScore = score;
          l.score_factors = factors;
          l.last_scored_at = nowIso;
          l.custom_fields = { ...(l.custom_fields || {}), ...updatedCustom };
          updatedLead = l;
        }
      });
    }

    scoredCount++;
    totalScore += score;

    // 4. Trigger workflow event (lead.scored) if score >= threshold
    if (score >= threshold) {
      triggeredWorkflows++;
      try {
        await triggerWorkflows(
          'lead.scored',
          updatedLead || { ...lead, score, last_scored_at: nowIso, custom_fields: updatedCustom },
          {
            score,
            threshold,
            previousScore,
            workspaceId: lead.workspace_id || lead.workspaceId || workspaceId || 'default',
            resource: 'leads',
            event: 'lead.scored',
          },
        );
      } catch (wfErr) {
        console.error('[lead-scoring] Error triggering lead.scored workflow:', wfErr.message);
      }
    }
  }

  return {
    totalProcessed: leadsToProcess.length,
    scoredCount,
    triggeredWorkflows,
    averageScore: scoredCount > 0 ? Math.round(totalScore / scoredCount) : 0,
  };
}

/**
 * Schedules the nightly lead scoring repeatable job.
 *
 * @param {object} [options]
 * @param {string} [options.cron='0 2 * * *'] - Cron pattern (default 02:00 UTC)
 * @param {object} [options.data={}] - Job data payload
 * @param {boolean} [options.forceInMemory=false] - Force in-memory queue fallback
 * @returns {Promise<object>}
 */
export async function scheduleNightlyLeadScoring({
  cron = NIGHTLY_CRON,
  data = {},
  forceInMemory = false,
} = {}) {
  const queue = getLeadScoringQueue({ forceInMemory });
  return await queue.add('nightly-lead-scoring', data, {
    repeat: { pattern: cron },
    removeOnComplete: true,
    removeOnFail: false,
  });
}

/**
 * Starts the BullMQ worker for lead scoring.
 *
 * @param {object} [options]
 * @param {boolean} [options.forceInMemory=false]
 * @returns {Worker|null}
 */
export function startLeadScoringWorker({ forceInMemory = false } = {}) {
  const connection = getRedisConnection();
  if (!connection || forceInMemory) return null;
  if (worker) return worker;

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      return await scoreAllLeads(job.data);
    },
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[lead-scoring-worker] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

export async function stopLeadScoringWorker() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

export function getInMemoryLeadScoringJobs() {
  return inMemoryQueue ? inMemoryQueue.getJobs() : [];
}

export function clearLeadScoringQueue() {
  if (inMemoryQueue) {
    inMemoryQueue.clear();
  }
}

export async function closeLeadScoringQueue() {
  await stopLeadScoringWorker();
  if (bullQueue) {
    await bullQueue.close();
    bullQueue = null;
  }
  if (inMemoryQueue) {
    await inMemoryQueue.close();
    inMemoryQueue = null;
  }
}
