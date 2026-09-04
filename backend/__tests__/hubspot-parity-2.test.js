import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { closePool } from '../db/pg.js';
import { resetTestDb, seedTestUser, loginAs } from './setup.js';
import { readDb } from '../store.js';

let app, token;
const sleep = ms => new Promise(r => setTimeout(r, ms));

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
});

afterAll(async () => {
  await closePool();
});

let formPermalink, submitRecordId, workflowId, branchWorkflowId, queuedLeadId;
const auth = () => ({ Authorization: `Bearer ${token}` });

describe('Smart Forms & Progressive Profiling', () => {
  it('POST /api/forms creates a form with fields', async () => {
    const res = await request(app).post('/api/forms').set(auth()).send({
      name: 'Demo Request',
      fields: [
        { key: 'name', label: 'Full name', type: 'text', required: true },
        { key: 'email', label: 'Work email', type: 'text', required: true },
        { key: 'company', label: 'Company', type: 'text', required: false },
        { key: 'phone', label: 'Phone', type: 'text', required: true, visibleIf: { field: 'company', op: 'eq', value: 'Acme' } },
        { key: 'budget', label: 'Budget', type: 'dropdown', options: ['<10k', '10-50k', '>50k'], progressive: true, required: false }
      ]
    });
    expect(res.status).toBe(201);
    expect(res.body.permalink).toBeTruthy();
    formPermalink = res.body.permalink;
  });

  it('GET /api/forms/:permalink is public and returns fields', async () => {
    const res = await request(app).get(`/api/forms/${formPermalink}`);
    expect(res.status).toBe(200);
    expect(res.body.form.permalink).toBe(formPermalink);
    expect(res.body.form.fields.length).toBeGreaterThanOrEqual(5);
  });

  it('POST /api/forms/:permalink/submit creates a lead without conditional fields', async () => {
    // Simulate the tracking pixel firing before the form submission
    await request(app).post('/api/web/event').send({ vid: 'v_test123', type: 'pageview', page: '/demo-request' });
    const res = await request(app)
      .post(`/api/forms/${formPermalink}/submit`)
      .send({ name: 'Rania Visitor', email: 'rania@acme.com', company: 'Acme', phone: '+21611111111', vid: 'v_test123' });
    expect(res.status).toBe(201);
    expect(res.body.recordId).toBeTruthy();
    submitRecordId = res.body.recordId;
  });

  it('conditional required field enforced when condition matches', async () => {
    // company=Acme makes "phone" visible and required → missing phone must fail
    const res = await request(app)
      .post(`/api/forms/${formPermalink}/submit`)
      .send({ name: 'No Phone', email: 'nophone@acme.com', company: 'Acme' });
    expect(res.status).toBe(400);
    expect(res.body.fields).toContain('phone');
  });

  it('conditional field ignored when condition does not match', async () => {
    const res = await request(app)
      .post(`/api/forms/${formPermalink}/submit`)
      .send({ name: 'Bob', email: 'bob@corp.com', company: 'Other' });
    expect(res.status).toBe(201);
  });

  it('progressive profiling hides already-filled fields for known visitors', async () => {
    const res = await request(app).get(`/api/forms/${formPermalink}?recordId=${submitRecordId}`);
    expect(res.status).toBe(200);
    const keys = res.body.form.fields.map(f => f.key);
    expect(keys).not.toContain('email');
    expect(keys).not.toContain('name');
    expect(keys).toContain('budget');
  });

  it('web attribution is stored on the submitted lead', async () => {
    const lead = await request(app).get(`/api/leads/${submitRecordId}`).set(auth());
    expect(lead.status).toBe(200);
    expect(lead.body.visitCount).toBeGreaterThanOrEqual(1);
    expect(lead.body.attributionSource).toBeTruthy();
  });
});

describe('Visual Workflow Builder (node-based branching)', () => {
  it('POST /api/workflows creates a node workflow', async () => {
    const res = await request(app).post('/api/workflows').set(auth()).send({
      name: 'Lead routing by value',
      event: 'lead.created',
      nodes: [
        { id: 'n1', type: 'start', next: 'n2' },
        { id: 'n2', type: 'condition', config: { field: 'value', op: 'gte', value: '1000' }, trueNext: 'n3', falseNext: 'n4' },
        { id: 'n3', type: 'action', config: { type: 'activity', title: 'High value lead', subtype: 'Task' }, next: null },
        { id: 'n4', type: 'action', config: { type: 'activity', title: 'Low value lead', subtype: 'Task' }, next: null }
      ]
    });
    expect(res.status).toBe(201);
    workflowId = res.body.id;
  });

  it('POST /api/workflows/:id/enable activates it', async () => {
    const res = await request(app).post(`/api/workflows/${workflowId}/enable`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  it('POST /api/workflows/:id/test dry-runs the graph (true branch)', async () => {
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/test`)
      .set(auth())
      .send({ record: { value: 5000, email: 'big@corp.com' } });
    expect(res.status).toBe(200);
    const executed = res.body.steps.map(s => (s.config ? s.config.title || s.config.type : s.type));
    expect(executed).toContain('High value lead');
    expect(executed).not.toContain('Low value lead');
  });

  it('creating a high-value lead fires the true branch', async () => {
    const lead = await request(app).post('/api/leads').set(auth()).send({ name: 'Big Buyer', email: 'bigbuyer@corp.com', value: 90000 });
    expect(lead.status).toBe(201);
    await sleep(80);
    const db = await readDb();
    const activity = db.activities.find(a => a.workflowId === workflowId && a.title === 'High value lead');
    expect(activity).toBeTruthy();
  });

  it('creating a low-value lead fires the false branch', async () => {
    const lead = await request(app).post('/api/leads').set(auth()).send({ name: 'Small Buyer', email: 'smallbuyer@corp.com', value: 100 });
    expect(lead.status).toBe(201);
    await sleep(80);
    const db = await readDb();
    const activity = db.activities.find(a => a.workflowId === workflowId && a.title === 'Low value lead');
    expect(activity).toBeTruthy();
  });
});

describe('Execution Queue', () => {
  it('POST /api/executions queues a delayed action', async () => {
    const res = await request(app).post('/api/executions').set(auth()).send({
      resource: 'leads',
      recordId: submitRecordId,
      action: { type: 'task', title: 'Queued follow-up call', owner: 'Test User', priority: 'High' },
      dueAt: new Date(Date.now() - 60000).toISOString()
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
  });

  it('GET /api/executions lists queued items', async () => {
    const res = await request(app).get('/api/executions').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/executions/process drains due items', async () => {
    const res = await request(app).post('/api/executions/process').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.executed).toBeGreaterThanOrEqual(1);
    const db = await readDb();
    const task = db.tasks.find(t => t.title === 'Queued follow-up call');
    expect(task).toBeTruthy();
    expect(task.workflowId).toBe('');
    const done = db.executionQueue.filter(i => i.status === 'done');
    expect(done.length).toBeGreaterThanOrEqual(1);
  });

  it('workflow delay nodes schedule a queue item', async () => {
    const res = await request(app).post('/api/workflows').set(auth()).send({
      name: 'Nurture drip',
      event: 'lead.created',
      nodes: [
        { id: 'd1', type: 'start', next: 'd2' },
        { id: 'd2', type: 'delay', config: { minutes: 30, action: { type: 'task', title: 'Nurture follow-up', owner: 'Test User' } }, next: 'd3' },
        { id: 'd3', type: 'action', config: { type: 'activity', title: 'Nurture enrolled', subtype: 'Note' }, next: null }
      ]
    });
    expect(res.status).toBe(201);
    await request(app).post(`/api/workflows/${res.body.id}/enable`).set(auth());
    await request(app).post('/api/leads').set(auth()).send({ name: 'Drip Lead', email: 'drip@corp.com' });
    await sleep(80);
    const db = await readDb();
    const queued = db.executionQueue.filter(i => i.flowId === res.body.id && i.action.title === 'Nurture follow-up');
    expect(queued.length).toBe(1);
    expect(queued[0].dueAt).toBeTruthy();
  });
});

describe('Sales Workspace Dashboard', () => {
  it('GET /api/dashboard/sales returns unified metrics', async () => {
    const res = await request(app).get('/api/dashboard/sales').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.metrics).toBeTruthy();
    expect(typeof res.body.metrics.pipelineValue).toBe('number');
    expect(Array.isArray(res.body.dealsByStage)).toBe(true);
    expect(Array.isArray(res.body.funnel)).toBe(true);
    expect(Array.isArray(res.body.recentActivity)).toBe(true);
    expect(res.body.winRate).toBeGreaterThanOrEqual(0);
  });
});