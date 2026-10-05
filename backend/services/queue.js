import { readDb, mutateDb } from '../store.js';
import { findRecord } from '../db/legacy-records.js';
import { id, now } from '../helpers.js';
import { runAction, deliverMessages } from './actions.js';
import { DEFAULT_SETTINGS } from './config.js';

const MAX_QUEUE = 2000;
let running = false;

// Schedules a delayed workflow action. Call inside a mutateDb snapshot so the
// item is persisted atomically with any other changes.
export function scheduleExecution(db, { flowId, flowName, resource, record, action, dueAt, context = {} }) {
  if (!action || !action.type) return null;
  if (!Array.isArray(db.executionQueue)) db.executionQueue = [];
  const item = {
    id: id('exec'),
    flowId,
    flowName: flowName || '',
    resource,
    recordId: record?.id || '',
    action: {
      ...action,
      to: action.to,
      subject: action.subject,
      body: action.body
    },
    context,
    dueAt: dueAt || now(),
    status: 'pending',
    attempts: 0,
    createdAt: now(),
    ranAt: ''
  };
  db.executionQueue.unshift(item);
  if (db.executionQueue.length > MAX_QUEUE) db.executionQueue.length = MAX_QUEUE;
  return item;
}

// Runs every due queued action. Idempotent per item (claimed before running)
// and guarded against concurrent workers.
export async function processExecutionQueue() {
  if (running) return { skipped: true };
  running = true;
  try {
    const db = await readDb();
    const settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
    const due = (db.executionQueue || [])
      .filter(item => item.status === 'pending' && item.dueAt <= now())
      .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1))
      .slice(0, 100);

    let executed = 0;
    let failed = 0;
    const errors = [];
    const outbound = [];

    for (const item of due) {
      try {
        await mutateDb(db => {
          const live = db.executionQueue.find(x => x.id === item.id);
          if (!live || live.status !== 'pending') return;
          live.status = 'processing';
          live.attempts = (live.attempts || 0) + 1;
        });
        await mutateDb(async db => {
          const record = item.resource ? (await findRecord(item.recordId, [item.resource], db))?.record : null;
          if (item.recordId && !record) {
            const live = db.executionQueue.find(x => x.id === item.id);
            if (live) {
              live.status = 'failed';
              live.error = 'Referenced record no longer exists';
              live.updatedAt = now();
            }
            executed++;
            return;
          }
          const messages = await runAction(db, item.action, record || {}, { resource: item.resource, flowId: item.flowId, flowName: item.flowName });
          outbound.push(...messages);
          const live = db.executionQueue.find(x => x.id === item.id);
          if (live) {
            live.status = 'done';
            live.ranAt = now();
          }
        });
        executed++;
      } catch (error) {
        failed++;
        const message = error.message || 'Execution failed';
        errors.push({ itemId: item.id, error: message });
        await mutateDb(db => {
          const live = db.executionQueue.find(x => x.id === item.id);
          if (!live) return;
          if (live.attempts >= 3) {
            live.status = 'failed';
          } else {
            // Exponential backoff so retries are spaced apart instead of firing
            // on the very next worker tick.
            live.status = 'pending';
            live.retryAt = live.retryAt || live.createdAt || now();
            live.attempts = live.attempts || 1;
            const backoffMs = Math.min(64_000, 5_000 * 2 ** (live.attempts - 1));
            live.dueAt = new Date(Date.now() + backoffMs).toISOString();
          }
          live.error = message;
          live.updatedAt = now();
        });
      }
    }

    await deliverMessages(outbound, settings);
    return { executed, failed, errors, queued: due.length };
  } finally {
    running = false;
  }
}

export async function retryExecution(itemId) {
  return mutateDb(db => {
    const item = (db.executionQueue || []).find(x => x.id === itemId);
    if (!item) return null;
    item.status = 'pending';
    item.error = '';
    item.attempts = 0;
    item.updatedAt = now();
    return item;
  });
}
