import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest';
import { parseDelayToMs } from '../duration.js';
import {
  getWorkflowWaitQueue,
  scheduleWorkflowWaitJob,
  resumeWorkflowFromWait,
  clearWorkflowWaitQueue,
  getInMemoryWaitJobs,
  closeWorkflowWaitQueue,
} from '../workflowQueue.js';
import {
  triggerWorkflows,
  dryRunFlow,
} from '../workflows.js';
import { mutateDb } from '../../store.js';
import { resetTestDb, cleanupTestDb } from '../../__tests__/setup.js';
import { repoFor } from '../../db/repositories/index.js';
import * as actions from '../actions.js';

describe('Workflow Wait Node & Delayed Execution Engine', () => {
  beforeAll(async () => {
    await resetTestDb();
  }, 30000);

  afterAll(async () => {
    await closeWorkflowWaitQueue();
    await cleanupTestDb();
  });

  beforeEach(async () => {
    clearWorkflowWaitQueue();
    await mutateDb((db) => {
      db.workflows = [];
      db.executionQueue = [];
      db.audit = [];
    });
  });

  describe('1. Duration Parsing (parseDelayToMs)', () => {
    it('parses human-readable day formats', () => {
      expect(parseDelayToMs('1 day')).toBe(86400000);
      expect(parseDelayToMs('2 days')).toBe(172800000);
      expect(parseDelayToMs('1d')).toBe(86400000);
      expect(parseDelayToMs('3 d')).toBe(259200000);
    });

    it('parses human-readable hour formats', () => {
      expect(parseDelayToMs('2 hours')).toBe(7200000);
      expect(parseDelayToMs('1 hour')).toBe(3600000);
      expect(parseDelayToMs('4h')).toBe(14400000);
      expect(parseDelayToMs('1.5 hours')).toBe(5400000);
    });

    it('parses human-readable minute formats', () => {
      expect(parseDelayToMs('30 minutes')).toBe(1800000);
      expect(parseDelayToMs('15 mins')).toBe(900000);
      expect(parseDelayToMs('10m')).toBe(600000);
      expect(parseDelayToMs('1 min')).toBe(60000);
    });

    it('parses human-readable second formats', () => {
      expect(parseDelayToMs('45 seconds')).toBe(45000);
      expect(parseDelayToMs('30s')).toBe(30000);
      expect(parseDelayToMs('10 sec')).toBe(10000);
    });

    it('parses human-readable week formats', () => {
      expect(parseDelayToMs('1 week')).toBe(604800000);
      expect(parseDelayToMs('2 weeks')).toBe(1209600000);
      expect(parseDelayToMs('1w')).toBe(604800000);
    });

    it('parses structured object formats', () => {
      expect(parseDelayToMs({ amount: 3, unit: 'days' })).toBe(259200000);
      expect(parseDelayToMs({ amount: 2, unit: 'hours' })).toBe(7200000);
      expect(parseDelayToMs({ amount: '5', unit: 'minutes' })).toBe(300000);
      expect(parseDelayToMs({ delay: '1 day' })).toBe(86400000);
      expect(parseDelayToMs({ duration: '2 hours' })).toBe(7200000);
    });

    it('handles raw milliseconds and boundary/fallback cases', () => {
      expect(parseDelayToMs(5000)).toBe(5000);
      expect(parseDelayToMs('60000')).toBe(60000);
      expect(parseDelayToMs(0)).toBe(0);
      expect(parseDelayToMs(-500)).toBe(0);
      expect(parseDelayToMs(null)).toBe(0);
      expect(parseDelayToMs(undefined)).toBe(0);
      expect(parseDelayToMs('')).toBe(0);
      expect(parseDelayToMs('invalid string')).toBe(0);
      expect(parseDelayToMs({})).toBe(0);
    });
  });

  describe('2. Queue Service & In-Memory Fallback', () => {
    it('provides a functional queue and stores delayed jobs in memory when Redis is absent', async () => {
      const queue = getWorkflowWaitQueue();
      expect(queue).toBeDefined();

      const jobInfo = await scheduleWorkflowWaitJob({
        workflowId: 'wf_test_1',
        runId: 'run_test_1',
        waitNodeId: 'node_wait_1',
        targetNodeIds: ['node_action_1'],
        delayMs: 86400000,
        record: { id: 'lead_1', email: 'test@example.com' },
        context: { workspaceId: 'default' },
        event: 'lead.created',
      });

      expect(jobInfo).toMatchObject({
        workflowId: 'wf_test_1',
        runId: 'run_test_1',
        waitNodeId: 'node_wait_1',
        targetNodeIds: ['node_action_1'],
        delayMs: 86400000,
      });

      const jobs = getInMemoryWaitJobs();
      expect(jobs.length).toBe(1);
      expect(jobs[0].data.workflowId).toBe('wf_test_1');
      expect(jobs[0].delay).toBe(86400000);
    });
  });

  describe('3. Wait Node Graph Execution & Step Logging', () => {
    it('schedules delayed job, pauses branch execution, and logs waiting step', async () => {
      const runActionSpy = vi.spyOn(actions, 'runAction').mockResolvedValue([]);

      const workflowId = 'wf_wait_graph_test';
      const workflow = {
        id: workflowId,
        name: 'Wait Graph Test',
        event: 'lead.created',
        enabled: true,
        workspace_id: 'default',
        nodes: [
          { id: 'node_start', type: 'trigger', data: { label: 'Lead Created' } },
          { id: 'node_wait', type: 'wait', config: { delay: '1 day' }, data: { label: 'Wait 1 Day' } },
          {
            id: 'node_action',
            type: 'action',
            config: { type: 'task', title: 'Follow-up Task' },
            data: { label: 'Create Follow-up' },
          },
        ],
        edges: [
          { source: 'node_start', target: 'node_wait' },
          { source: 'node_wait', target: 'node_action' },
        ],
      };

      await mutateDb((db) => {
        db.workflows.push(workflow);
      });

      const sampleRecord = { id: 'lead_101', name: 'John Doe', email: 'john@example.com' };

      // Trigger the workflow
      await triggerWorkflows('lead.created', sampleRecord, { workspaceId: 'default' });

      // Verify downstream action was NOT called synchronously
      expect(runActionSpy).not.toHaveBeenCalled();

      // Verify delayed job was queued in the wait queue
      const queuedJobs = getInMemoryWaitJobs();
      expect(queuedJobs.length).toBe(1);
      const scheduledJob = queuedJobs[0].data;
      expect(scheduledJob.workflowId).toBe(workflowId);
      expect(scheduledJob.waitNodeId).toBe('node_wait');
      expect(scheduledJob.targetNodeIds).toEqual(['node_action']);
      expect(scheduledJob.delayMs).toBe(86400000);

      // Verify workflow_runs entry in PostgreSQL
      const runsRepo = repoFor('workflowRuns');
      const runs = await runsRepo.findByWorkflowId(workflowId);
      expect(runs.data.length).toBe(1);

      const run = runs.data[0];
      expect(run.status).toBe('waiting');
      expect(run.completed_at).toBeNull();

      const steps = run.steps;
      expect(steps.length).toBe(2);
      expect(steps[0].nodeId).toBe('node_start');
      expect(steps[0].status).toBe('success');

      expect(steps[1].nodeId).toBe('node_wait');
      expect(steps[1].nodeType).toBe('wait');
      expect(steps[1].status).toBe('waiting');
      expect(steps[1].output.delay).toBe('1 day');
      expect(steps[1].output.delayMs).toBe(86400000);
      expect(steps[1].output.scheduledResumeAt).toBeDefined();

      runActionSpy.mockRestore();
    });
  });

  describe('4. Worker Resumption Execution', () => {
    it('resumes execution from target nodes and completes run with success', async () => {
      const runActionSpy = vi.spyOn(actions, 'runAction').mockResolvedValue([]);

      const workflowId = 'wf_resume_test';
      const workflow = {
        id: workflowId,
        name: 'Resumption Test Workflow',
        event: 'contact.created',
        enabled: true,
        workspace_id: 'default',
        nodes: [
          { id: 'node_start', type: 'trigger', data: { label: 'Contact Created' } },
          { id: 'node_wait', type: 'wait', config: { duration: '2 hours' } },
          {
            id: 'node_action',
            type: 'action',
            config: { type: 'email', to: 'test@example.com', subject: 'Welcome' },
          },
        ],
        edges: [
          { source: 'node_start', target: 'node_wait' },
          { source: 'node_wait', target: 'node_action' },
        ],
      };

      await mutateDb((db) => {
        db.workflows.push(workflow);
      });

      const sampleRecord = { id: 'cnt_202', name: 'Jane Smith', email: 'jane@example.com' };

      // 1. Initial trigger -> enters waiting state
      await triggerWorkflows('contact.created', sampleRecord, { workspaceId: 'default' });
      expect(runActionSpy).not.toHaveBeenCalled();

      const queuedJobs = getInMemoryWaitJobs();
      expect(queuedJobs.length).toBe(1);
      const jobData = queuedJobs[0].data;

      // 2. Simulate worker picking up the delayed job and resuming
      const resumeResult = await resumeWorkflowFromWait(jobData);
      expect(resumeResult.status).toBe('success');
      expect(resumeResult.executedNodes).toContain('node_action');
      expect(runActionSpy).toHaveBeenCalledTimes(1);

      // 3. Verify workflow_runs is updated to 'success' with all steps preserved
      const runsRepo = repoFor('workflowRuns');
      const updatedRun = await runsRepo.findById(jobData.runId);

      expect(updatedRun.status).toBe('success');
      expect(updatedRun.completed_at).not.toBeNull();

      const finalSteps = updatedRun.steps;
      expect(finalSteps.length).toBe(3);
      expect(finalSteps[0].nodeId).toBe('node_start');
      expect(finalSteps[0].status).toBe('success');
      expect(finalSteps[1].nodeId).toBe('node_wait');
      expect(finalSteps[1].status).toBe('waiting');
      expect(finalSteps[2].nodeId).toBe('node_action');
      expect(finalSteps[2].status).toBe('success');

      runActionSpy.mockRestore();
    });
  });

  describe('5. Conditional Wait Branch Execution', () => {
    it('schedules wait only when condition branch is active (true branch)', async () => {
      const runActionSpy = vi.spyOn(actions, 'runAction').mockResolvedValue([]);

      const workflowId = 'wf_cond_wait_true';
      const workflow = {
        id: workflowId,
        name: 'Conditional Wait True',
        event: 'lead.created',
        enabled: true,
        workspace_id: 'default',
        nodes: [
          { id: 'start', type: 'trigger' },
          {
            id: 'check_vip',
            type: 'condition',
            config: { field: 'score', operator: 'greater_than', value: 50 },
          },
          { id: 'wait_node', type: 'wait', config: { delay: '30 minutes' } },
          { id: 'action_vip', type: 'action', config: { type: 'task', title: 'VIP task' } },
          { id: 'action_regular', type: 'action', config: { type: 'task', title: 'Regular task' } },
        ],
        edges: [
          { source: 'start', target: 'check_vip' },
          { source: 'check_vip', target: 'wait_node', sourceHandle: 'true' },
          { source: 'wait_node', target: 'action_vip' },
          { source: 'check_vip', target: 'action_regular', sourceHandle: 'false' },
        ],
      };

      await mutateDb((db) => {
        db.workflows.push(workflow);
      });

      // Score is 80 (> 50) -> true branch -> wait_node scheduled
      await triggerWorkflows('lead.created', { id: 'lead_vip', score: 80 }, { workspaceId: 'default' });

      expect(runActionSpy).not.toHaveBeenCalled();

      const queuedJobs = getInMemoryWaitJobs();
      expect(queuedJobs.length).toBe(1);
      expect(queuedJobs[0].data.waitNodeId).toBe('wait_node');
      expect(queuedJobs[0].data.targetNodeIds).toEqual(['action_vip']);

      const runsRepo = repoFor('workflowRuns');
      const runs = await runsRepo.findByWorkflowId(workflowId);
      expect(runs.data[0].status).toBe('waiting');

      const stepNodeIds = runs.data[0].steps.map((s) => s.nodeId);
      expect(stepNodeIds).toContain('start');
      expect(stepNodeIds).toContain('check_vip');
      expect(stepNodeIds).toContain('action_regular'); // marked skipped
      expect(stepNodeIds).toContain('wait_node');

      const regularStep = runs.data[0].steps.find((s) => s.nodeId === 'action_regular');
      expect(regularStep.status).toBe('skipped');

      runActionSpy.mockRestore();
    });

    it('skips wait node when condition evaluates to false and does not schedule job', async () => {
      const runActionSpy = vi.spyOn(actions, 'runAction').mockResolvedValue([]);

      const workflowId = 'wf_cond_wait_false';
      const workflow = {
        id: workflowId,
        name: 'Conditional Wait False',
        event: 'lead.created',
        enabled: true,
        workspace_id: 'default',
        nodes: [
          { id: 'start', type: 'trigger' },
          {
            id: 'check_vip',
            type: 'condition',
            config: { field: 'score', operator: 'greater_than', value: 50 },
          },
          { id: 'wait_node', type: 'wait', config: { delay: '30 minutes' } },
          { id: 'action_vip', type: 'action', config: { type: 'task', title: 'VIP task' } },
          { id: 'action_regular', type: 'action', config: { type: 'task', title: 'Regular task' } },
        ],
        edges: [
          { source: 'start', target: 'check_vip' },
          { source: 'check_vip', target: 'wait_node', sourceHandle: 'true' },
          { source: 'wait_node', target: 'action_vip' },
          { source: 'check_vip', target: 'action_regular', sourceHandle: 'false' },
        ],
      };

      await mutateDb((db) => {
        db.workflows.push(workflow);
      });

      // Score is 20 (<= 50) -> false branch -> regular action runs immediately, wait_node skipped
      await triggerWorkflows('lead.created', { id: 'lead_regular', score: 20 }, { workspaceId: 'default' });

      // Action regular was executed synchronously
      expect(runActionSpy).toHaveBeenCalledTimes(1);

      // No wait jobs scheduled
      const queuedJobs = getInMemoryWaitJobs();
      expect(queuedJobs.length).toBe(0);

      // Run status is success
      const runsRepo = repoFor('workflowRuns');
      const runs = await runsRepo.findByWorkflowId(workflowId);
      expect(runs.data[0].status).toBe('success');

      // Wait node was marked skipped
      const waitStep = runs.data[0].steps.find((s) => s.nodeId === 'wait_node');
      expect(waitStep).toBeDefined();
      expect(waitStep.status).toBe('skipped');

      runActionSpy.mockRestore();
    });
  });

  describe('6. Parallel Branches and Dry Run Simulation', () => {
    it('executes synchronous branch while keeping delayed branch in waiting state', async () => {
      const runActionSpy = vi.spyOn(actions, 'runAction').mockResolvedValue([]);

      const workflowId = 'wf_parallel_wait';
      const workflow = {
        id: workflowId,
        name: 'Parallel Wait and Immediate Action',
        event: 'deal.created',
        enabled: true,
        workspace_id: 'default',
        nodes: [
          { id: 'start', type: 'trigger' },
          { id: 'immediate_action', type: 'action', config: { type: 'task', title: 'Immediate Task' } },
          { id: 'wait_step', type: 'wait', config: { delay: '1 hour' } },
          { id: 'delayed_action', type: 'action', config: { type: 'task', title: 'Delayed Task' } },
        ],
        edges: [
          { source: 'start', target: 'immediate_action' },
          { source: 'start', target: 'wait_step' },
          { source: 'wait_step', target: 'delayed_action' },
        ],
      };

      await mutateDb((db) => {
        db.workflows.push(workflow);
      });

      await triggerWorkflows('deal.created', { id: 'deal_1', amount: 5000 }, { workspaceId: 'default' });

      // Immediate action executed
      expect(runActionSpy).toHaveBeenCalledTimes(1);

      // Wait step queued
      const queuedJobs = getInMemoryWaitJobs();
      expect(queuedJobs.length).toBe(1);
      expect(queuedJobs[0].data.targetNodeIds).toEqual(['delayed_action']);

      // Overall run is waiting
      const runsRepo = repoFor('workflowRuns');
      const runs = await runsRepo.findByWorkflowId(workflowId);
      expect(runs.data[0].status).toBe('waiting');

      // Now resume the delayed branch
      await resumeWorkflowFromWait(queuedJobs[0].data);
      expect(runActionSpy).toHaveBeenCalledTimes(2);

      const finalRun = await runsRepo.findById(runs.data[0].id);
      expect(finalRun.status).toBe('success');

      runActionSpy.mockRestore();
    });

    it('simulates wait node in dryRunFlow without scheduling or persisting', () => {
      const flow = {
        id: 'flow_dry',
        nodes: [
          { id: '1', type: 'trigger' },
          { id: '2', type: 'wait', config: { delay: '45 seconds' } },
          { id: '3', type: 'action', config: { type: 'email' } },
        ],
        edges: [
          { source: '1', target: '2' },
          { source: '2', target: '3' },
        ],
      };

      const result = dryRunFlow(flow, { name: 'Test' });
      expect(result.steps.length).toBe(3);
      expect(result.steps[1].type).toBe('wait');
      expect(result.steps[1].result).toBe('waiting');
      expect(result.steps[1].delayMs).toBe(45000);
      expect(result.executed).toBe(1);
    });
  });
});
