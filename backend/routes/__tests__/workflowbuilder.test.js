import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { closePool } from '../../db/pg.js';
import { resetTestDb, seedTestUser, loginAs } from '../../__tests__/setup.js';

let app;
let token;
let workflowId;
let initialGraph;
let updatedGraph;

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);

  initialGraph = {
    nodes: [
      { id: 'n1', type: 'trigger', data: { event: 'lead.created' } },
      { id: 'n2', type: 'action', data: { title: 'Contact lead' } }
    ],
    edges: [{ source: 'n1', target: 'n2' }]
  };
  updatedGraph = {
    nodes: [
      { id: 'n1', type: 'trigger', data: { event: 'lead.updated' } },
      { id: 'n2', type: 'condition', data: { field: 'value', operator: 'gt', value: 100 } }
    ],
    edges: [{ source: 'n1', target: 'n2' }]
  };
});

afterAll(async () => {
  await closePool();
});

describe('Workflow builder graph routes', () => {
  it('creates a workflow with the complete node and edge graph', async () => {
    const response = await request(app)
      .post('/api/workflowbuilder')
      .set(auth())
      .send({ name: 'Graph workflow', ...initialGraph });

    expect(response.status).toBe(201);
    expect(response.body.nodes).toEqual(initialGraph.nodes);
    expect(response.body.edges).toEqual(initialGraph.edges);
    workflowId = response.body.id;
  });

  it('rejects graph fields that are not arrays', async () => {
    const response = await request(app)
      .post('/api/workflowbuilder')
      .set(auth())
      .send({ name: 'Invalid graph', nodes: {}, edges: [] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('nodes must be an array');
  });

  it('updates the complete graph for an existing workflow', async () => {
    const response = await request(app)
      .put(`/api/workflowbuilder/${workflowId}`)
      .set(auth())
      .send(updatedGraph);

    expect(response.status).toBe(200);
    expect(response.body.nodes).toEqual(updatedGraph.nodes);
    expect(response.body.edges).toEqual(updatedGraph.edges);
  });

  it('returns the complete graph for an existing workflow', async () => {
    const response = await request(app)
      .get(`/api/workflowbuilder/${workflowId}`)
      .set(auth());

    expect(response.status).toBe(200);
    expect(response.body.nodes).toEqual(updatedGraph.nodes);
    expect(response.body.edges).toEqual(updatedGraph.edges);
  });

  it('returns 404 for a missing workflow', async () => {
    const getResponse = await request(app)
      .get('/api/workflowbuilder/missing-workflow')
      .set(auth());
    const putResponse = await request(app)
      .put('/api/workflowbuilder/missing-workflow')
      .set(auth())
      .send(updatedGraph);

    expect(getResponse.status).toBe(404);
    expect(putResponse.status).toBe(404);
  });
});
