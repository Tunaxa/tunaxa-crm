import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { closePool } from '../db/pg.js';
import { resetTestDb, seedTestUser, loginAs } from './setup.js';

let app, token;

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

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('Reports', () => {
  it('GET /api/reports/pipeline returns pipeline stats', async () => {
    const res = await request(app).get('/api/reports/pipeline').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pipeline');
    expect(res.body).toHaveProperty('totalValue');
    expect(Array.isArray(res.body.pipeline)).toBe(true);
    expect(res.body.pipeline.length).toBeGreaterThan(0);
    expect(res.body.pipeline[0]).toHaveProperty('stage');
    expect(res.body.pipeline[0]).toHaveProperty('count');
    expect(res.body.pipeline[0]).toHaveProperty('value');
  });

  it('GET /api/reports/funnel returns funnel stages', async () => {
    const res = await request(app).get('/api/reports/funnel?days=30').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('stages');
    expect(Array.isArray(res.body.stages)).toBe(true);
    expect(res.body.stages.length).toBeGreaterThan(0);
    expect(res.body).toHaveProperty('conversionRate');
  });

  it('GET /api/reports/activity returns activity stats', async () => {
    const res = await request(app).get('/api/reports/activity?days=30').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('byType');
    expect(res.body).toHaveProperty('byDay');
  });

  it('GET /api/reports/revenue returns monthly revenue', async () => {
    const res = await request(app).get('/api/reports/revenue?months=3').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(3);
    expect(res.body.data[0]).toHaveProperty('month');
    expect(res.body.data[0]).toHaveProperty('won');
  });

  it('GET /api/reports/team returns team performance', async () => {
    const res = await request(app).get('/api/reports/team').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('members');
    expect(Array.isArray(res.body.members)).toBe(true);
  });

  it('GET /api/reports/sources returns lead sources', async () => {
    const res = await request(app).get('/api/reports/sources').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sources');
    expect(Array.isArray(res.body.sources)).toBe(true);
  });

  it('Reports require authentication', async () => {
    const res = await request(app).get('/api/reports/pipeline');
    expect(res.status).toBe(401);
  });
});

describe('Permissions', () => {
  it('GET /api/permissions returns default permissions', async () => {
    const res = await request(app).get('/api/permissions').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('contact');
    expect(res.body.contact).toHaveProperty('admin');
    expect(res.body.contact).toHaveProperty('member');
    expect(res.body.contact).toHaveProperty('viewer');
  });

  it('PUT /api/permissions updates permissions', async () => {
    const res = await request(app).put('/api/permissions').set(auth()).send({ deal: { admin: ['read', 'write', 'delete'], member: ['read', 'write'], viewer: ['read'] } });
    expect(res.status).toBe(200);
    expect(res.body.deal.member).toEqual(['read', 'write']);
  });

  it('PUT /api/permissions/:type updates single type', async () => {
    const res = await request(app).put('/api/permissions/lead').set(auth()).send({ admin: ['read', 'write'], member: ['read'], viewer: [] });
    expect(res.status).toBe(200);
    expect(res.body.admin).toEqual(['read', 'write']);
  });
});

describe('Onboarding', () => {
  it('GET /api/onboarding/status returns status', async () => {
    const res = await request(app).get('/api/onboarding/status').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('completed');
    expect(res.body).toHaveProperty('currentStep');
    expect(res.body).toHaveProperty('steps');
    expect(Array.isArray(res.body.steps)).toBe(true);
    expect(res.body.steps.length).toBe(6);
  });

  it('POST /api/onboarding/step completes profile step', async () => {
    const res = await request(app).post('/api/onboarding/step').set(auth()).send({ step: 'profile', data: { name: 'Updated Name' } });
    expect(res.status).toBe(200);
    expect(res.body.completedSteps).toContain('profile');
    expect(res.body.currentStep).toBe('company');
  });

  it('POST /api/onboarding/step completes company step', async () => {
    const res = await request(app).post('/api/onboarding/step').set(auth()).send({ step: 'company', data: { name: 'Test Corp', industry: 'SaaS' } });
    expect(res.status).toBe(200);
    expect(res.body.completedSteps).toContain('company');
    expect(res.body.company.name).toBe('Test Corp');
  });

  it('POST /api/onboarding/step completes pipeline step', async () => {
    const res = await request(app).post('/api/onboarding/step').set(auth()).send({ step: 'pipeline', data: { stages: ['Lead', 'Demo', 'Closed'] } });
    expect(res.status).toBe(200);
    expect(res.body.pipeline.stages).toEqual(['Lead', 'Demo', 'Closed']);
  });

  it('POST /api/onboarding/skip skips all steps', async () => {
    await request(app).post('/api/onboarding/reset').set(auth());
    const res = await request(app).post('/api/onboarding/skip').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
    expect(res.body.currentStep).toBe('done');
  });

  it('GET /api/onboarding/template returns template', async () => {
    const res = await request(app).get('/api/onboarding/template?industry=saas').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('stages');
    expect(res.body.stages.length).toBeGreaterThan(0);
  });

  it('Onboarding requires authentication', async () => {
    const res = await request(app).get('/api/onboarding/status');
    expect(res.status).toBe(401);
  });
});
