import { beforeEach, describe, expect, it, vi } from 'vitest';

const actionsMock = vi.hoisted(() => ({
  runAction: vi.fn(),
  deliverMessages: vi.fn(),
}));

const queueMock = vi.hoisted(() => ({
  scheduleExecution: vi.fn(),
}));

const storeMock = vi.hoisted(() => {
  let dbState = {
    workflows: [],
    settings: {},
    audit: [],
    messages: [],
    executionQueue: [],
  };
  return {
    getState: () => dbState,
    setState: (newState) => {
      dbState = { ...dbState, ...newState };
    },
    reset: () => {
      dbState = {
        workflows: [],
        settings: {},
        audit: [],
        messages: [],
        executionQueue: [],
      };
    },
    readDb: vi.fn(async () => dbState),
    mutateDb: vi.fn(async (callback) => callback(dbState)),
  };
});

vi.mock('../actions.js', () => ({
  runAction: actionsMock.runAction,
  deliverMessages: actionsMock.deliverMessages,
}));

vi.mock('../queue.js', () => ({
  scheduleExecution: queueMock.scheduleExecution,
}));

vi.mock('../../store.js', () => ({
  readDb: storeMock.readDb,
  mutateDb: storeMock.mutateDb,
}));

import {
  evaluateCondition,
  evaluateOperator,
  getFieldValue,
  executeNodeGraph,
  executeLegacyWorkflow,
  triggerWorkflows,
  dryRunFlow,
} from '../workflows.js';

describe('Workflow Node Graph Execution Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.reset();
    actionsMock.runAction.mockResolvedValue([]);
    actionsMock.deliverMessages.mockResolvedValue([]);
  });

  describe('Field resolution and operator evaluation', () => {
    it('resolves direct, nested, and custom fields', () => {
      const record = {
        name: 'Alice',
        company: { name: 'Acme Corp' },
        custom_fields: { plan: 'Enterprise', nested: { score: 95 } },
      };

      expect(getFieldValue(record, 'name')).toBe('Alice');
      expect(getFieldValue(record, 'company.name')).toBe('Acme Corp');
      expect(getFieldValue(record, 'plan')).toBe('Enterprise');
      expect(getFieldValue(record, 'custom_fields.plan')).toBe('Enterprise');
      expect(getFieldValue(record, 'nested.score')).toBe(95);
      expect(getFieldValue(record, 'missing.field')).toBeUndefined();
    });

    it('evaluates comparison and equality operators case-insensitively', () => {
      expect(evaluateOperator('equals', 'Lead', 'lead')).toBe(true);
      expect(evaluateOperator('equals', '100', 100)).toBe(true);
      expect(evaluateOperator('not_equals', 'Lead', 'Customer')).toBe(true);
      expect(evaluateOperator('contains', 'hello world', 'WORLD')).toBe(true);
      expect(evaluateOperator('not_contains', 'hello world', 'xyz')).toBe(true);
      expect(evaluateOperator('greater_than', 50, 20)).toBe(true);
      expect(evaluateOperator('greater_than', '50', '20')).toBe(true);
      expect(evaluateOperator('less_than', 10, 20)).toBe(true);
      expect(evaluateOperator('is_empty', '')).toBe(true);
      expect(evaluateOperator('is_empty', null)).toBe(true);
      expect(evaluateOperator('is_empty', [])).toBe(true);
      expect(evaluateOperator('is_not_empty', 'value')).toBe(true);
      expect(evaluateOperator('in', 'vip', ['standard', 'vip', 'gold'])).toBe(true);
      expect(evaluateOperator('in', 'vip', 'standard, vip, gold')).toBe(true);
      expect(evaluateOperator('not_in', 'bronze', ['standard', 'vip'])).toBe(true);
    });

    it('evaluates single and compound condition rules', () => {
      const record = {
        status: 'Active',
        value: 1200,
        custom_fields: { tier: 'Platinum' },
      };

      expect(evaluateCondition({ field: 'status', operator: 'equals', value: 'active' }, record)).toBe(true);
      expect(evaluateCondition({ field: 'tier', operator: 'equals', value: 'Platinum' }, record)).toBe(true);

      // Compound rules (match: 'all')
      const allRules = {
        match: 'all',
        rules: [
          { field: 'status', operator: 'equals', value: 'Active' },
          { field: 'value', operator: 'greater_than', value: 1000 },
        ],
      };
      expect(evaluateCondition(allRules, record)).toBe(true);

      // Compound rules (match: 'any')
      const anyRules = {
        match: 'any',
        rules: [
          { field: 'status', operator: 'equals', value: 'Inactive' },
          { field: 'value', operator: 'greater_than', value: 500 },
        ],
      };
      expect(evaluateCondition(anyRules, record)).toBe(true);
    });
  });

  describe('1. Linear Graph (Trigger -> Action)', () => {
    it('executes the action connected to the trigger', async () => {
      const workflow = {
        id: 'flow_linear',
        name: 'Linear Flow',
        event: 'lead.created',
        enabled: true,
        nodes: [
          { id: 'n_trigger', type: 'trigger' },
          {
            id: 'n_action',
            type: 'action',
            config: { type: 'send_email', to: 'test@example.com', subject: 'Welcome' },
          },
        ],
        edges: [
          { source: 'n_trigger', target: 'n_action' },
        ],
      };

      const record = { id: 'lead_1', email: 'test@example.com', first_name: 'Test' };
      const result = await executeNodeGraph(workflow, 'lead.created', record);

      expect(result.executedNodes).toEqual(['n_trigger', 'n_action']);
      expect(result.executedActions).toEqual(['n_action']);
      expect(actionsMock.runAction).toHaveBeenCalledTimes(1);
      expect(actionsMock.runAction).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ type: 'email', to: 'test@example.com' }),
        record,
        expect.objectContaining({ flowId: 'flow_linear' }),
      );
    });
  });

  describe('2. Condition True Branch (Trigger -> Condition [true] -> Action)', () => {
    it('executes the action when condition evaluates to true', async () => {
      const workflow = {
        id: 'flow_cond_true',
        name: 'Condition True Flow',
        event: 'lead.created',
        enabled: true,
        nodes: [
          { id: 'n_trigger', type: 'trigger' },
          {
            id: 'n_cond',
            type: 'condition',
            config: { field: 'value', operator: 'greater_than', value: 100 },
          },
          {
            id: 'n_action',
            type: 'action',
            config: { type: 'create_task', title: 'High value follow-up' },
          },
        ],
        edges: [
          { source: 'n_trigger', target: 'n_cond' },
          { source: 'n_cond', target: 'n_action', sourceHandle: 'true' },
        ],
      };

      const record = { id: 'lead_2', value: 250 };
      const result = await executeNodeGraph(workflow, 'lead.created', record);

      expect(result.executedNodes).toEqual(['n_trigger', 'n_cond', 'n_action']);
      expect(result.executedActions).toEqual(['n_action']);
      expect(actionsMock.runAction).toHaveBeenCalledTimes(1);
      expect(actionsMock.runAction).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ type: 'task', title: 'High value follow-up' }),
        record,
        expect.anything(),
      );
    });
  });

  describe('3. Condition False Branch Skip (Trigger -> Condition [false] -> Action)', () => {
    it('skips execution of the downstream action when condition evaluates to false', async () => {
      const workflow = {
        id: 'flow_cond_false_skip',
        name: 'Condition False Skip',
        event: 'lead.created',
        enabled: true,
        nodes: [
          { id: 'n_trigger', type: 'trigger' },
          {
            id: 'n_cond',
            type: 'condition',
            config: { field: 'status', operator: 'equals', value: 'Qualified' },
          },
          {
            id: 'n_action',
            type: 'action',
            config: { type: 'send_email', subject: 'Only for qualified' },
          },
        ],
        edges: [
          { source: 'n_trigger', target: 'n_cond' },
          { source: 'n_cond', target: 'n_action', sourceHandle: 'true' },
        ],
      };

      const record = { id: 'lead_3', status: 'Unqualified' };
      const result = await executeNodeGraph(workflow, 'lead.created', record);

      expect(result.executedNodes).toEqual(['n_trigger', 'n_cond']);
      expect(result.executedActions).toEqual([]);
      expect(actionsMock.runAction).not.toHaveBeenCalled();
    });
  });

  describe('4. True / False Branching', () => {
    const branchingWorkflow = {
      id: 'flow_branching',
      name: 'True False Branching Flow',
      event: 'deal.updated',
      enabled: true,
      nodes: [
        { id: 'n_start', type: 'trigger' },
        {
          id: 'n_eval',
          type: 'condition',
          config: { field: 'stage', operator: 'equals', value: 'Won' },
        },
        {
          id: 'n_action_true',
          type: 'action',
          config: { type: 'create_task', title: 'Send welcome basket' },
        },
        {
          id: 'n_action_false',
          type: 'action',
          config: { type: 'create_task', title: 'Schedule re-engagement call' },
        },
      ],
      edges: [
        { source: 'n_start', target: 'n_eval' },
        { source: 'n_eval', target: 'n_action_true', sourceHandle: 'true' },
        { source: 'n_eval', target: 'n_action_false', sourceHandle: 'false' },
      ],
    };

    it('executes only the true branch action when condition matches', async () => {
      const record = { id: 'deal_1', stage: 'Won' };
      const result = await executeNodeGraph(branchingWorkflow, 'deal.updated', record);

      expect(result.executedNodes).toEqual(['n_start', 'n_eval', 'n_action_true']);
      expect(result.executedActions).toEqual(['n_action_true']);
      expect(actionsMock.runAction).toHaveBeenCalledTimes(1);
      expect(actionsMock.runAction).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ title: 'Send welcome basket' }),
        record,
        expect.anything(),
      );
    });

    it('executes only the false branch action when condition fails', async () => {
      const record = { id: 'deal_2', stage: 'Lost' };
      const result = await executeNodeGraph(branchingWorkflow, 'deal.updated', record);

      expect(result.executedNodes).toEqual(['n_start', 'n_eval', 'n_action_false']);
      expect(result.executedActions).toEqual(['n_action_false']);
      expect(actionsMock.runAction).toHaveBeenCalledTimes(1);
      expect(actionsMock.runAction).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ title: 'Schedule re-engagement call' }),
        record,
        expect.anything(),
      );
    });
  });

  describe('5. Multi-Step & Chained Conditions', () => {
    const chainedWorkflow = {
      id: 'flow_chained',
      name: 'Chained Conditions Flow',
      event: 'lead.created',
      enabled: true,
      nodes: [
        { id: 'n_trigger', type: 'trigger' },
        {
          id: 'n_cond1',
          type: 'condition',
          config: { field: 'country', operator: 'equals', value: 'US' },
        },
        {
          id: 'n_cond2',
          type: 'condition',
          config: { field: 'score', operator: 'greater_than', value: 80 },
        },
        {
          id: 'n_action',
          type: 'action',
          config: { type: 'create_task', title: 'Route to US Enterprise Lead Team' },
        },
      ],
      edges: [
        { source: 'n_trigger', target: 'n_cond1' },
        { source: 'n_cond1', target: 'n_cond2', sourceHandle: 'true' },
        { source: 'n_cond2', target: 'n_action', sourceHandle: 'true' },
      ],
    };

    it('aborts at Step 1 when Condition 1 fails', async () => {
      const record = { id: 'lead_fr', country: 'FR', score: 95 };
      const result = await executeNodeGraph(chainedWorkflow, 'lead.created', record);

      expect(result.executedNodes).toEqual(['n_trigger', 'n_cond1']);
      expect(actionsMock.runAction).not.toHaveBeenCalled();
    });

    it('aborts at Step 2 when Condition 1 passes but Condition 2 fails', async () => {
      const record = { id: 'lead_us_low', country: 'US', score: 60 };
      const result = await executeNodeGraph(chainedWorkflow, 'lead.created', record);

      expect(result.executedNodes).toEqual(['n_trigger', 'n_cond1', 'n_cond2']);
      expect(actionsMock.runAction).not.toHaveBeenCalled();
    });

    it('executes action when all sequential conditions pass', async () => {
      const record = { id: 'lead_us_high', country: 'US', score: 90 };
      const result = await executeNodeGraph(chainedWorkflow, 'lead.created', record);

      expect(result.executedNodes).toEqual(['n_trigger', 'n_cond1', 'n_cond2', 'n_action']);
      expect(result.executedActions).toEqual(['n_action']);
      expect(actionsMock.runAction).toHaveBeenCalledTimes(1);
    });
  });

  describe('6. Cycle Detection & Infinite Loop Guard', () => {
    it('terminates gracefully on self-referential or cyclic graph edges', async () => {
      const cyclicWorkflow = {
        id: 'flow_cyclic',
        name: 'Cyclic Workflow',
        event: 'task.completed',
        enabled: true,
        nodes: [
          { id: 'node_a', type: 'trigger' },
          { id: 'node_b', type: 'action', config: { type: 'log_activity', title: 'Ping' } },
          { id: 'node_c', type: 'action', config: { type: 'log_activity', title: 'Pong' } },
        ],
        edges: [
          { source: 'node_a', target: 'node_b' },
          { source: 'node_b', target: 'node_c' },
          { source: 'node_c', target: 'node_b' }, // cyclic edge
        ],
      };

      const record = { id: 'task_1', title: 'Test Task' };
      const result = await executeNodeGraph(cyclicWorkflow, 'task.completed', record);

      // node_b and node_c each run once, cycle is caught
      expect(result.executedNodes).toEqual(['node_a', 'node_b', 'node_c']);
      expect(result.executedActions).toEqual(['node_b', 'node_c']);
      expect(actionsMock.runAction).toHaveBeenCalledTimes(2);
    });
  });

  describe('7. Delay Handling', () => {
    it('schedules execution when delay node is reached', async () => {
      const workflow = {
        id: 'flow_delay_node',
        name: 'Delay Node Workflow',
        event: 'lead.created',
        enabled: true,
        nodes: [
          { id: 'n_trigger', type: 'trigger' },
          {
            id: 'n_delay',
            type: 'delay',
            config: { minutes: 30, action: { type: 'email', to: 'lead@test.com', subject: 'Followup' } },
          },
        ],
        edges: [
          { source: 'n_trigger', target: 'n_delay' },
        ],
      };

      const record = { id: 'lead_del', email: 'lead@test.com' };
      await executeNodeGraph(workflow, 'lead.created', record);

      expect(queueMock.scheduleExecution).toHaveBeenCalledTimes(1);
      expect(queueMock.scheduleExecution).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          flowId: 'flow_delay_node',
          action: expect.objectContaining({ type: 'email' }),
        }),
      );
    });

    it('schedules execution when action has delayMinutes property', async () => {
      const workflow = {
        id: 'flow_action_delay',
        name: 'Action Delay Workflow',
        event: 'contact.created',
        enabled: true,
        nodes: [
          { id: 'n_trigger', type: 'trigger' },
          {
            id: 'n_action',
            type: 'action',
            config: { type: 'email', delayMinutes: 60, to: 'contact@test.com' },
          },
        ],
        edges: [
          { source: 'n_trigger', target: 'n_action' },
        ],
      };

      const record = { id: 'contact_1', email: 'contact@test.com' };
      await executeNodeGraph(workflow, 'contact.created', record);

      expect(queueMock.scheduleExecution).toHaveBeenCalledTimes(1);
      expect(actionsMock.runAction).not.toHaveBeenCalled();
    });
  });

  describe('8. Edge Formats & Connection Backward Compatibility', () => {
    it('supports connections array with from/to and fromHandle properties', async () => {
      const workflow = {
        id: 'flow_connections',
        name: 'Connections Workflow',
        event: 'lead.created',
        enabled: true,
        nodes: [
          { id: 't1', type: 'trigger' },
          { id: 'c1', type: 'condition', config: { field: 'status', operator: 'equals', value: 'Open' } },
          { id: 'a1', type: 'action', config: { type: 'task', title: 'Open Lead Task' } },
        ],
        connections: [
          { from: 't1', to: 'c1' },
          { from: 'c1', to: 'a1', fromHandle: 'true' },
        ],
      };

      const record = { id: 'l1', status: 'Open' };
      const result = await executeNodeGraph(workflow, 'lead.created', record);

      expect(result.executedNodes).toEqual(['t1', 'c1', 'a1']);
      expect(actionsMock.runAction).toHaveBeenCalledTimes(1);
    });

    it('supports node link pointers (next, trueNext, falseNext)', async () => {
      const workflow = {
        id: 'flow_next_pointers',
        name: 'Next Pointers Workflow',
        event: 'lead.created',
        enabled: true,
        nodes: [
          { id: 'start_node', type: 'start', next: 'cond_node' },
          {
            id: 'cond_node',
            type: 'condition',
            config: { field: 'score', operator: 'greater_than', value: 50 },
            trueNext: 'true_action',
            falseNext: 'false_action',
          },
          { id: 'true_action', type: 'action', config: { type: 'task', title: 'High Score' } },
          { id: 'false_action', type: 'action', config: { type: 'task', title: 'Low Score' } },
        ],
      };

      const recordHigh = { id: 'lead_high', score: 75 };
      const resHigh = await executeNodeGraph(workflow, 'lead.created', recordHigh);
      expect(resHigh.executedNodes).toEqual(['start_node', 'cond_node', 'true_action']);

      vi.clearAllMocks();
      const recordLow = { id: 'lead_low', score: 20 };
      const resLow = await executeNodeGraph(workflow, 'lead.created', recordLow);
      expect(resLow.executedNodes).toEqual(['start_node', 'cond_node', 'false_action']);
    });
  });

  describe('9. Legacy Flat Workflows Compatibility', () => {
    it('executes legacy flat workflow.actions when workflow lacks nodes', async () => {
      const legacyWorkflow = {
        id: 'flow_legacy',
        name: 'Legacy Flat Workflow',
        event: 'lead.created',
        enabled: true,
        actions: [
          { type: 'task', title: 'Legacy task 1' },
          { type: 'email', to: 'user@test.com', subject: 'Legacy email 2' },
        ],
      };

      storeMock.setState({
        workflows: [legacyWorkflow],
        settings: {},
        audit: [],
        messages: [],
      });

      const record = { id: 'lead_leg', email: 'user@test.com' };
      await triggerWorkflows('leads', 'lead.created', record);

      expect(actionsMock.runAction).toHaveBeenCalledTimes(2);
      expect(actionsMock.runAction).toHaveBeenNthCalledWith(
        1,
        expect.any(Object),
        expect.objectContaining({ title: 'Legacy task 1' }),
        record,
        expect.objectContaining({ flowId: 'flow_legacy' }),
      );
      expect(actionsMock.runAction).toHaveBeenNthCalledWith(
        2,
        expect.any(Object),
        expect.objectContaining({ subject: 'Legacy email 2' }),
        record,
        expect.objectContaining({ flowId: 'flow_legacy' }),
      );
    });

    it('triggers graph workflows seamlessly through triggerWorkflows(event, record, context)', async () => {
      const graphWorkflow = {
        id: 'flow_via_trigger',
        name: 'Trigger Workflows Graph Flow',
        event: 'ticket.created',
        enabled: true,
        nodes: [
          { id: 't_node', type: 'trigger' },
          { id: 'a_node', type: 'action', config: { type: 'activity', title: 'Ticket activity' } },
        ],
        edges: [
          { source: 't_node', target: 'a_node' },
        ],
      };

      storeMock.setState({
        workflows: [graphWorkflow],
        settings: {},
        audit: [],
        messages: [],
      });

      const record = { id: 'ticket_1', subject: 'Help needed' };
      await triggerWorkflows('ticket.created', record, { resource: 'tickets' });

      expect(actionsMock.runAction).toHaveBeenCalledTimes(1);
      expect(actionsMock.runAction).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ type: 'activity', title: 'Ticket activity' }),
        record,
        expect.objectContaining({ flowId: 'flow_via_trigger', resource: 'tickets' }),
      );
    });
  });

  describe('10. dryRunFlow simulation', () => {
    it('simulates graph branch traversal without side-effects', () => {
      const workflow = {
        id: 'flow_sim',
        nodes: [
          { id: 's1', type: 'trigger' },
          { id: 'c1', type: 'condition', config: { field: 'status', operator: 'equals', value: 'Active' } },
          { id: 'a1', type: 'action', config: { type: 'email' } },
        ],
        edges: [
          { source: 's1', target: 'c1' },
          { source: 'c1', target: 'a1', sourceHandle: 'true' },
        ],
      };

      const resActive = dryRunFlow(workflow, { status: 'Active' });
      expect(resActive.executed).toBe(1);
      expect(resActive.steps.map(s => s.node)).toEqual(['s1', 'c1', 'a1']);

      const resInactive = dryRunFlow(workflow, { status: 'Inactive' });
      expect(resInactive.executed).toBe(0);
      expect(resInactive.steps.map(s => s.node)).toEqual(['s1', 'c1']);
    });
  });
});
