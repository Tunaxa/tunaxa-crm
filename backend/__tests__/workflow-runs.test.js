import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import { query } from '../db/pg.js';
import { mutateDb } from '../store.js';
import { triggerWorkflows } from '../services/workflows.js';
import * as actions from '../services/actions.js';

let app;
let token;

async function seedTenantUser({ email, workspaceId, role = 'Owner' }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('test123', salt, 64).toString('hex');
  const user = {
    id: `usr_${email}`,
    name: email,
    email,
    password: `${salt}:${hash}`,
    role,
    workspaceId,
    createdAt: new Date().toISOString(),
  };
  await mutateDb(db => {
    db.users.push(user);
    db.team.push({
      id: `team_${email}`,
      name: user.name,
      email: user.email,
      role,
      status: 'Active',
      createdAt: user.createdAt,
    });
  });
  const res = await request(app).post('/api/auth/login').send({ email, password: 'test123' });
  return res.body.token;
}

const auth = req => req.set('Authorization', `Bearer ${token}`);
const asUser = userToken => req => req.set('Authorization', `Bearer ${userToken}`);

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
}, 30000);

afterAll(() => cleanupTestDb());

describe('Workflow execution runs history & tracking', () => {
  it('records a successful run with node steps on graph execution', async () => {
    const workflowId = 'wf_success_graph';
    const workflow = {
      id: workflowId,
      name: 'Successful Graph Workflow',
      event: 'lead.created',
      enabled: true,
      workspace_id: 'default',
      nodes: [
        { id: 't_node', type: 'trigger', data: { label: 'Lead Created Trigger' } },
        {
          id: 'c_node',
          type: 'condition',
          data: { label: 'Check Status' },
          config: { field: 'status', operator: 'equals', value: 'Qualified' },
        },
        {
          id: 'a_node',
          type: 'action',
          data: { label: 'Create Follow-up Task' },
          config: { type: 'task', title: 'Follow-up with {{first_name}}' },
        },
      ],
      edges: [
        { source: 't_node', target: 'c_node' },
        { source: 'c_node', target: 'a_node', sourceHandle: 'true' },
      ],
    };

    await mutateDb(db => {
      db.workflows.push(workflow);
    });

    const record = { id: 'lead_1', first_name: 'Ada', status: 'Qualified' };
    await triggerWorkflows('leads', 'lead.created', record);

    const { rows } = await query(
      'SELECT * FROM workflow_runs WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT 1',
      [workflowId],
    );

    expect(rows).toHaveLength(1);
    const run = rows[0];
    expect(run.status).toBe('success');
    expect(run.trigger_event).toBe('lead.created');
    expect(run.completed_at).toBeTruthy();
    expect(run.error_message).toBeNull();

    // Verify per-step node results
    expect(run.steps).toHaveLength(3);
    expect(run.steps[0]).toMatchObject({
      nodeId: 't_node',
      nodeType: 'trigger',
      status: 'success',
    });
    expect(run.steps[1]).toMatchObject({
      nodeId: 'c_node',
      nodeType: 'condition',
      status: 'success',
      output: { result: true },
    });
    expect(run.steps[2]).toMatchObject({
      nodeId: 'a_node',
      nodeType: 'action',
      status: 'success',
    });
  });

  it('records skipped downstream node steps when a condition branch evaluates to false', async () => {
    const workflowId = 'wf_skip_branch';
    const workflow = {
      id: workflowId,
      name: 'Skipped Branch Workflow',
      event: 'lead.created',
      enabled: true,
      workspace_id: 'default',
      nodes: [
        { id: 'start_n', type: 'trigger' },
        {
          id: 'cond_n',
          type: 'condition',
          config: { field: 'status', operator: 'equals', value: 'Hot' },
        },
        {
          id: 'hot_action',
          type: 'action',
          config: { type: 'task', title: 'Priority Dispatch' },
        },
      ],
      edges: [
        { source: 'start_n', target: 'cond_n' },
        { source: 'cond_n', target: 'hot_action', sourceHandle: 'true' },
      ],
    };

    await mutateDb(db => {
      db.workflows.push(workflow);
    });

    const record = { id: 'lead_cold', status: 'Cold' };
    await triggerWorkflows('leads', 'lead.created', record);

    const { rows } = await query(
      'SELECT * FROM workflow_runs WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT 1',
      [workflowId],
    );

    expect(rows).toHaveLength(1);
    const run = rows[0];
    expect(run.status).toBe('success');
    expect(run.completed_at).toBeTruthy();

    const condStep = run.steps.find(s => s.nodeId === 'cond_n');
    expect(condStep).toMatchObject({
      status: 'success',
      output: { result: false },
    });

    const skippedStep = run.steps.find(s => s.nodeId === 'hot_action');
    expect(skippedStep).toMatchObject({
      status: 'skipped',
    });
  });

  it('records failed step and overall failed run when an action throws an error', async () => {
    const workflowId = 'wf_failing_action';
    const workflow = {
      id: workflowId,
      name: 'Failing Action Workflow',
      event: 'deal.won',
      enabled: true,
      workspace_id: 'default',
      nodes: [
        { id: 'trig', type: 'trigger' },
        { id: 'act_fail', type: 'action', config: { type: 'email', to: 'exec@test.com' } },
      ],
      edges: [
        { source: 'trig', target: 'act_fail' },
      ],
    };

    await mutateDb(db => {
      db.workflows.push(workflow);
    });

    const runActionSpy = vi.spyOn(actions, 'runAction').mockRejectedValueOnce(
      new Error('SMTP Gateway Connection Timeout'),
    );

    const record = { id: 'deal_fail', stage: 'won', name: 'Big Deal' };
    await triggerWorkflows('deals', 'deal.won', record);

    runActionSpy.mockRestore();

    const { rows } = await query(
      'SELECT * FROM workflow_runs WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT 1',
      [workflowId],
    );

    expect(rows).toHaveLength(1);
    const run = rows[0];
    expect(run.status).toBe('failed');
    expect(run.error_message).toContain('SMTP Gateway Connection Timeout');
    expect(run.completed_at).toBeTruthy();

    const failStep = run.steps.find(s => s.nodeId === 'act_fail');
    expect(failStep).toMatchObject({
      status: 'failed',
      error: 'SMTP Gateway Connection Timeout',
    });
  });

  it('GET /api/workflows/:id/runs returns paginated historical runs sorted newest first', async () => {
    const workflowId = 'wf_api_runs_test';
    await mutateDb(db => {
      db.workflows.push({
        id: workflowId,
        name: 'API Runs Test Workflow',
        event: 'task.completed',
        enabled: true,
        workspace_id: 'default',
      });
    });

    // Create 3 runs directly via SQL
    await query(
      `INSERT INTO workflow_runs (workflow_id, trigger_event, status, started_at, completed_at, steps, workspace_id)
       VALUES
       ($1, 'task.completed', 'success', NOW() - INTERVAL '3 minutes', NOW() - INTERVAL '2 minutes', '[]', 'default'),
       ($1, 'task.completed', 'failed', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '1 minute', '[]', 'default'),
       ($1, 'task.completed', 'success', NOW() - INTERVAL '1 minute', NOW(), '[]', 'default')`,
      [workflowId],
    );

    const res = await auth(request(app).get(`/api/workflows/${workflowId}/runs?limit=2&page=1`));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(2);
    expect(res.body.totalPages).toBe(2);
    expect(res.body.data).toHaveLength(2);

    // Newest first check
    const firstDate = new Date(res.body.data[0].started_at).getTime();
    const secondDate = new Date(res.body.data[1].started_at).getTime();
    expect(firstDate).toBeGreaterThanOrEqual(secondDate);

    // 404 for non-existent workflow
    const missing = await auth(request(app).get('/api/workflows/non_existent_id/runs'));
    expect(missing.status).toBe(404);
  });

  it('enforces tenant workspace scoping on GET /api/workflows/:id/runs', async () => {
    const acmeToken = await seedTenantUser({ email: 'acme_runner@test.com', workspaceId: 'ws_acme' });
    const globexToken = await seedTenantUser({ email: 'globex_runner@test.com', workspaceId: 'ws_globex' });

    const sharedWorkflowId = 'wf_tenant_runs';
    await mutateDb(db => {
      db.workflows.push({
        id: sharedWorkflowId,
        name: 'Tenant Workflow',
        event: 'ticket.created',
        enabled: true,
      });
    });

    // Seed run in ws_acme
    await query(
      `INSERT INTO workflow_runs (workflow_id, trigger_event, status, started_at, completed_at, steps, workspace_id)
       VALUES ($1, 'ticket.created', 'success', NOW(), NOW(), '[]', 'ws_acme')`,
      [sharedWorkflowId],
    );

    // Acme user sees the run
    const acmeRes = await asUser(acmeToken)(request(app).get(`/api/workflows/${sharedWorkflowId}/runs`));
    expect(acmeRes.status).toBe(200);
    expect(acmeRes.body.total).toBe(1);
    expect(acmeRes.body.data[0].workspace_id).toBe('ws_acme');

    // Globex user does not see Acme's run
    const globexRes = await asUser(globexToken)(request(app).get(`/api/workflows/${sharedWorkflowId}/runs`));
    expect(globexRes.status).toBe(200);
    expect(globexRes.body.total).toBe(0);
    expect(globexRes.body.data).toHaveLength(0);
  });
});
