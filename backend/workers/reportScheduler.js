import { Queue, Worker } from 'bullmq';
import { mutateDb } from '../store.js';
import { id } from '../helpers.js';
import { getSettings } from '../services/config.js';
import { sendEmail } from '../services/smtp.js';
import { generateReportEmailContent } from '../services/reportEmail.js';
import { listSavedReports, findSavedReport, updateSavedReport } from '../services/savedReports.js';
import { runReportQuery, isScheduleActive, isScheduleDue } from '../services/reports.js';

export const QUEUE_NAME = 'report-scheduler-queue';
export const WEEKLY_JOB_NAME = 'weekly-report-digest';

// Every Monday at 08:00. BullMQ evaluates cron in UTC, which is also the
// timezone isScheduleDue() compares against.
export const WEEKLY_CRON = '0 8 * * 1';

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
 * Queue stand-in used when no Redis connection is configured, mirroring the
 * fallback in workers/leadScoring.js and services/workflowQueue.js. It records
 * repeatable registrations instead of performing them, so scheduling is
 * verifiable without opening a socket.
 */
export class InMemoryReportSchedulerQueue {
  constructor(name) {
    this.name = name;
    this.jobs = [];
    this.repeatableJobs = [];
    this._counter = 1;
  }

  async add(name, data, opts = {}) {
    const job = {
      id: `report_schedule_job_${this._counter++}_${Date.now()}`,
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

export function getReportSchedulerQueue({ forceInMemory = false } = {}) {
  const connection = getRedisConnection();
  if (!connection || forceInMemory) {
    if (!inMemoryQueue) {
      inMemoryQueue = new InMemoryReportSchedulerQueue(QUEUE_NAME);
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

/** Deep link back into the CRM for the digest footer. */
function dashboardUrlFor(report) {
  const dbBase = process.env.PUBLIC_BASE_URL || '';
  return `${dbBase}/reports/${report.id || ''}`.replace(/\/{2,}/g, '/');
}

/**
 * Generates the aggregated rows for a saved report, scoped to its own
 * workspace so one tenant's schedule can never query another's records.
 *
 * @param {object} report
 * @returns {Promise<Array<{ group: string, value: number, count: number }>>}
 */
export async function generateReportData(report) {
  const definition = report.query && typeof report.query === 'object' ? report.query : report;
  return await runReportQuery({
    entity: definition.entity || report.entity,
    groupBy: definition.groupBy || definition.group_by,
    metric: definition.metric,
    field: definition.field,
    dateRange: definition.dateRange || definition.date_range,
    dateField: definition.dateField || definition.date_field,
    workspaceId: report.workspaceId || report.workspace_id || 'default',
  });
}

/**
 * Renders and dispatches one digest per configured recipient, recording a
 * `db.messages` row and a `db.notifications` row for each attempt.
 *
 * @param {object} report - Saved report with a validated schedule
 * @param {object} options
 * @param {Date} options.now - Execution timestamp
 * @param {Array} options.rows - Aggregated report rows
 * @returns {Promise<{ emailsSent: number, emailsDelivered: number, deliveries: Array, errors: Array }>}
 */
export async function deliverReportEmail(report, { now = new Date(), rows } = {}) {
  const schedule = report.schedule || {};
  const recipients = Array.isArray(schedule.recipients) ? schedule.recipients : [];
  const workspaceId = report.workspaceId || report.workspace_id || 'default';
  const settings = await getSettings();
  const content = generateReportEmailContent(report, rows, {
    generatedAt: now,
    currency: settings.currency,
    workspaceName: settings.workspaceName,
    dashboardUrl: dashboardUrlFor(report),
  });

  const deliveries = [];
  const errors = [];
  const sentAt = now.toISOString();

  for (const recipient of recipients) {
    let result = { delivered: false, status: 'Failed', error: 'unknown' };
    try {
      result = await sendEmail(settings, {
        to: recipient,
        subject: content.subject,
        text: content.text,
        html: content.html,
      });
    } catch (error) {
      result = { delivered: false, status: 'Failed', error: error.message };
    }

    const delivered = result?.delivered === true;
    deliveries.push({ recipient, delivered, status: result?.status || 'Saved', providerId: result?.providerId || '' });
    if (result?.status === 'Failed') {
      errors.push({ reportId: report.id, recipient, message: result?.error || 'Email delivery failed' });
    }

    try {
      await mutateDb((db) => {
        if (!Array.isArray(db.messages)) db.messages = [];
        db.messages.unshift({
          id: id('msg'),
          channel: 'email',
          to: recipient,
          subject: content.subject,
          body: content.text,
          html: content.html,
          direction: 'Outbound',
          status: result?.status || 'Saved',
          reportId: report.id,
          workspaceId,
          createdAt: sentAt,
          updatedAt: sentAt,
        });

        if (!Array.isArray(db.notifications)) db.notifications = [];
        db.notifications.unshift({
          id: id('notif'),
          type: 'report.scheduled',
          recipientEmail: recipient,
          recipientName: recipient,
          subject: content.subject,
          body: content.text,
          reportId: report.id,
          workspaceId,
          createdAt: sentAt,
        });
      });
    } catch (error) {
      errors.push({ reportId: report.id, recipient, message: `Log write failed: ${error.message}` });
    }
  }

  return {
    emailsSent: deliveries.length,
    emailsDelivered: deliveries.filter((d) => d.delivered).length,
    deliveries,
    errors,
  };
}

/** Persists `schedule.lastSentAt` on the saved report. */
async function markReportSent(report, sentAt) {
  const schedule = { ...(report.schedule || {}), lastSentAt: sentAt };
  const updated = await updateSavedReport(
    report.id,
    { schedule, scheduleEnabled: true, lastSentAt: sentAt },
    report.workspaceId || report.workspace_id,
  );
  return { ...(updated || report), schedule };
}

/**
 * Runs every due report schedule: query, render the digest, email the
 * recipients, and stamp `schedule.lastSentAt`.
 *
 * Reports whose schedule is disabled are skipped, as are weekly schedules whose
 * `dayOfWeek` does not match `now` - unless `force` is set, which is what the
 * `send-now` route and manual runs use.
 *
 * @param {object} [options]
 * @param {string} [options.workspaceId] - Restrict to one tenant
 * @param {string} [options.reportId] - Restrict to one saved report
 * @param {boolean} [options.force=false] - Ignore the weekday gate
 * @param {Date} [options.now=new Date()] - Execution timestamp
 * @returns {Promise<{ processedReports: number, emailsSent: number, emailsDelivered: number, errors: Array }>}
 */
export async function runScheduledReports({
  workspaceId,
  reportId,
  force = false,
  now = new Date(),
} = {}) {
  const errors = [];
  let processedReports = 0;
  let emailsSent = 0;
  let emailsDelivered = 0;

  let reports = await listSavedReports({ workspaceId });
  if (reportId) {
    reports = reports.filter((report) => report.id === reportId);
  }

  for (const report of reports) {
    const schedule = report.schedule;
    if (!isScheduleActive(schedule)) continue;
    if (!force && !isScheduleDue(schedule, now)) continue;

    try {
      const rows = await generateReportData(report);
      const result = await deliverReportEmail(report, { now, rows });
      emailsSent += result.emailsSent;
      emailsDelivered += result.emailsDelivered;
      errors.push(...result.errors);
      await markReportSent(report, now.toISOString());
      processedReports += 1;
    } catch (error) {
      errors.push({ reportId: report.id, message: error.message });
    }
  }

  return { processedReports, emailsSent, emailsDelivered, errors };
}

/**
 * Registers the repeatable weekly digest job.
 *
 * @param {object} [options]
 * @param {string} [options.cron=WEEKLY_CRON] - Cron pattern
 * @param {object} [options.data={}] - Job data payload
 * @param {boolean} [options.forceInMemory=false] - Force the in-memory fallback
 * @returns {Promise<object>}
 */
export async function scheduleWeeklyReports({
  cron = WEEKLY_CRON,
  data = {},
  forceInMemory = false,
} = {}) {
  const queue = getReportSchedulerQueue({ forceInMemory });
  return await queue.add(WEEKLY_JOB_NAME, data, {
    repeat: { pattern: cron },
    removeOnComplete: true,
    removeOnFail: false,
  });
}

/**
 * Starts the worker and registers the repeatable job. Safe to call more than
 * once; a no-op without a Redis connection.
 *
 * @param {object} [options]
 * @param {boolean} [options.forceInMemory=false]
 * @returns {Promise<Worker|null>}
 */
export async function initReportSchedulerWorker({ forceInMemory = false } = {}) {
  const connection = getRedisConnection();

  if (connection && !forceInMemory) {
    if (!worker) {
      worker = new Worker(
        QUEUE_NAME,
        async (job) => {
          return await runScheduledReports({
            workspaceId: job.data?.workspaceId,
            force: job.data?.force === true,
          });
        },
        { connection, concurrency: 1 },
      );

      worker.on('failed', (job, err) => {
        console.error(`[report-scheduler] Job ${job?.id} failed:`, err.message);
      });
    }
  }

  try {
    await scheduleWeeklyReports({ forceInMemory });
  } catch (error) {
    console.error('[report-scheduler] Failed to register repeatable job:', error.message);
  }

  return worker;
}

export async function stopReportSchedulerWorker() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

export function getInMemoryReportSchedulerJobs() {
  return inMemoryQueue ? inMemoryQueue.getJobs() : [];
}

export function clearReportSchedulerQueue() {
  if (inMemoryQueue) inMemoryQueue.clear();
}

export async function closeReportSchedulerQueue() {
  await stopReportSchedulerWorker();
  if (bullQueue) {
    await bullQueue.close();
    bullQueue = null;
  }
  if (inMemoryQueue) {
    await inMemoryQueue.close();
    inMemoryQueue = null;
  }
}

export { findSavedReport };
