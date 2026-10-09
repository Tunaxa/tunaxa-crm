import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { closePool } from '../db/pg.js';
import { resetTestDb, seedTestUser, loginAs } from './setup.js';

let app;
let token;

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

describe('multiple pipelines', () => {
  it('CRUD works for pipeline definitions', async () => {
    const create = await request(app)
      .post('/api/pipeline/definitions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Sales Pipeline',
        stages: [
          { key: 'lead', label: 'Lead', probability: 10, order: 0 },
          { key: 'qualified', label: 'Qualified', probability: 25, order: 1 },
          { key: 'closed_won', label: 'Won', probability: 100, order: 2 },
        ],
      });
    expect(create.status).toBe(201);
    expect(create.body).toHaveProperty('id');
    const id = create.body.id;

    const list = await request(app)
      .get('/api/pipeline/definitions')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.some((x) => x.id === id)).toBe(true);

    const upd = await request(app)
      .put(`/api/pipeline/definitions/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Enterprise Pipeline',
        stages: create.body.stages,
      });
    expect([200, 201]).toContain(upd.status);

    const del = await request(app)
      .delete(`/api/pipeline/definitions/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect([200, 204]).toContain(del.status);
  });

  it('two distinct pipelines coexist with different stages', async () => {
    const p1 = await request(app)
      .post('/api/pipeline/definitions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Pipeline A',
        stages: [
          { key: 'a1', label: 'A1', probability: 20, order: 0 },
          { key: 'a2', label: 'A2', probability: 60, order: 1 },
        ],
      });
    expect(p1.status).toBe(201);
    const p2 = await request(app)
      .post('/api/pipeline/definitions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Pipeline B',
        stages: [
          { key: 'b1', label: 'B1', probability: 15, order: 0 },
          { key: 'b2', label: 'B2', probability: 50, order: 1 },
          { key: 'b3', label: 'B3', probability: 80, order: 2 },
        ],
      });
    expect(p2.status).toBe(201);
    const list = await request(app)
      .get('/api/pipeline/definitions')
      .set('Authorization', `Bearer ${token}`);
    expect(list.body.some((x) => x.id === p1.body.id)).toBe(true);
    expect(list.body.some((x) => x.id === p2.body.id)).toBe(true);
    expect(p1.body.stages.length).toBe(2);
    expect(p2.body.stages.length).toBe(3);
  });

  it('deal can be created and linked to custom pipeline', async () => {
    const p = await request(app)
      .post('/api/pipeline/definitions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Custom',
        stages: [{ key: 'stage1', label: 'Stage1', probability: 30, order: 0 }],
      });
    expect(p.status).toBe(201);
    const deal = await request(app)
      .post('/api/deals')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Big Deal', amount: 1000, pipelineId: p.body.id });
    expect(deal.status).toBe(201);
    expect(deal.body.pipelineId).toBe(p.body.id);
  });
});
