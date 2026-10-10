import { Queue, Worker } from 'bullmq';
import { readDb } from '../store.js';
import { resumeNodeGraphExecution } from './workflows.js';

export const QUEUE_NAME = 'workflow-wait-queue';

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

class InMemoryWaitQueue {
  constructor(name) {
    this.name = name;
    this.jobs = [];
    this._counter = 1;
  }

  async add(name, data, opts = {}) {
    const job = {
      id: `wait_job_${this._counter++}_${Date.now()}`,
      name,
      data,
      opts,
      delay: opts.delay || 0,
      timestamp: Date.now(),
    };
    this.jobs.push(job);
    return job;
  }

  getJobs() {
    return [...this.jobs];
  }

  clear() {
    this.jobs = [];
  }

  async close() {
    this.jobs = [];
  }
}

let bullQueue = null;
let inMemoryQueue = null;
let worker = null;

export function getWorkflowWaitQueue({ forceInMemory = false } = {}) {
  const connection = getRedisConnection();

  if (!connection || forceInMemory) {
    if (!inMemoryQueue) {
      inMemoryQueue = new InMemoryWaitQueue(QUEUE_NAME);
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
 * Schedules a delayed workflow resumption job.
 *
 * @param {object} params
 * @param {string} params.workflowId
 * @param {string} params.runId
 * @param {string} params.waitNodeId
 * @param {string[]} params.targetNodeIds
 * @param {number} params.delayMs
 * @param {object} params.record
 * @param {object} params.context
 * @param {string} params.event
 * @param {string} params.workspaceId
 * @returns {Promise<object>}
 */
export async function scheduleWorkflowWaitJob({
  workflowId,
  runId,
  waitNodeId,
  targetNodeIds,
  delayMs = 0,
  record,
  context = {},
  event,
  workspaceId,
}) {
  const queue = getWorkflowWaitQueue();
  const normalizedTargets = Array.isArray(targetNodeIds)
    ? targetNodeIds
    : [targetNodeIds].filter(Boolean);

  const payload = {
    workflowId,
    runId,
    waitNodeId,
    targetNodeIds: normalizedTargets,
    delayMs: Math.max(0, Number(delayMs) || 0),
    record,
    context,
    event,
    workspaceId: workspaceId || context?.workspaceId || 'default',
  };

  const job = await queue.add('wait-resume', payload, {
    delay: payload.delayMs,
  });

  return {
    jobId: job.id,
    ...payload,
  };
}

/**
 * Resumes workflow node graph execution from a delayed job.
 *
 * @param {object} jobData
 * @returns {Promise<object>}
 */
export async function resumeWorkflowFromWait(jobData) {
  if (!jobData) {
    throw new Error('jobData is required to resume workflow');
  }

  const {
    workflowId,
    runId,
    targetNodeIds,
    record,
    context = {},
    event,
    workspaceId,
  } = jobData;

  const db = await readDb();
  let workflow = (db.workflows || []).find((w) => w.id === workflowId);
  if (!workflow && jobData.workflow) {
    workflow = jobData.workflow;
  }

  if (!workflow) {
    throw new Error(`Workflow "${workflowId}" not found for resumption`);
  }

  const resumeContext = {
    ...context,
    runId,
    workspaceId: workspaceId || workflow.workspace_id || workflow.workspaceId || 'default',
  };

  return await resumeNodeGraphExecution({
    workflow,
    runId,
    targetNodeIds,
    record,
    context: resumeContext,
    event,
  });
}

export function startWorkflowWaitWorker() {
  const connection = getRedisConnection();
  if (!connection) return null;
  if (worker) return worker;

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      return await resumeWorkflowFromWait(job.data);
    },
    {
      connection,
      concurrency: 5,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[workflow-wait-worker] Job ${job?.id} failed:`, err.message);
  });

  worker.on('completed', (job) => {
    console.log(`[workflow-wait-worker] Job ${job?.id} resumed workflow ${job.data?.workflowId}`);
  });

  return worker;
}

export async function stopWorkflowWaitWorker() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

export function getInMemoryWaitJobs() {
  return inMemoryQueue ? inMemoryQueue.getJobs() : [];
}

export function clearWorkflowWaitQueue() {
  if (inMemoryQueue) {
    inMemoryQueue.clear();
  }
}

export async function closeWorkflowWaitQueue() {
  if (bullQueue) {
    await bullQueue.close();
    bullQueue = null;
  }
  if (inMemoryQueue) {
    await inMemoryQueue.close();
    inMemoryQueue = null;
  }
}
