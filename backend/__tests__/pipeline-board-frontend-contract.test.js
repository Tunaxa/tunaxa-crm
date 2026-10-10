import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { cleanupTestDb, loginAs, resetTestDb, seedTestUser } from './setup.js';
import { checkDealSave, dealPayload, pipelineDeals, pipelinePayload } from '../../web/src/modules/sales/pipelines/pipelineDefinitions.ts';

let app, token;
beforeAll(async () => {
  await resetTestDb();
  app = (await import('../server.js')).app;
  await seedTestUser();
  token = await loginAs(app);
});
afterAll(() => cleanupTestDb());

// Definition CRUD is supplied by pending backend PR #461. These fixtures use its
// exact definition shape while testing the real, existing deal endpoints.
describe('Pipeline frontend payloads through the deal API', () => {
  it('persists distinct pipeline bindings and configured stage probabilities through create and move', async () => {
    const first = { id: 'pipeline_fixture_a', ...pipelinePayload('Sales', [{ key: 'new', label: 'New', probability: '10' }, { key: 'won', label: 'Won', probability: '100' }]) };
    const second = { id: 'pipeline_fixture_b', ...pipelinePayload('Enterprise', [{ key: 'review', label: 'Review', probability: '65' }]) };
    const create = async (definition, stage) => {
      const payload = dealPayload({ title: `Deal for ${definition.name}`, stage, value: 200 }, definition);
      const response = await request(app).post('/api/deals').set('Authorization', `Bearer ${token}`).send(payload);
      expect(response.status).toBe(201);
      checkDealSave(response.body, payload);
      expect(Number(response.body.probability)).toBe(payload.probability);
      return response.body;
    };
    const a = await create(first, 'new');
    const b = await create(second, 'review');
    const payload = dealPayload({ stage: 'won' }, first);
    const moved = await request(app).put(`/api/deals/${a.id}`).set('Authorization', `Bearer ${token}`).send(payload);
    expect(moved.status).toBe(200);
    checkDealSave(moved.body, payload);
    expect(Number(moved.body.probability)).toBe(100);
    const list = await request(app).get('/api/deals').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const data = Array.isArray(list.body) ? list.body : list.body.data;
    expect(pipelineDeals(data, first.id, [first, second]).map(row => row.id)).toEqual([a.id]);
    expect(pipelineDeals(data, second.id, [first, second]).map(row => row.id)).toEqual([b.id]);
  });
});
