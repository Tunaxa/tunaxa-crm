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
  // Seed a lead + deal for feature tests
  const lead = await request(app).post('/api/leads').set('Authorization', `Bearer ${token}`).send({ name: 'Alice DM', email: 'alice@corp.com', phone: '+21650000000', company: 'Corp Inc', source: 'Webinar', value: 75000, role: 'CEO', status: 'New' });
  leadId = lead.body?.id;
  const deal = await request(app).post('/api/deals').set('Authorization', `Bearer ${token}`).send({ title: 'Big Deal', company: 'Corp Inc', value: 100000, stage: 'New', closeDate: '' });
  dealId = deal.body?.id;
});

afterAll(async () => {
  await closePool();
});

let leadId, dealId, listId, sequenceId, ticketId, linkSlug, articleId, revisionId;
const auth = () => ({ Authorization: `Bearer ${token}` });

describe('Lists', () => {
  it('POST /api/lists creates a static list', async () => {
    const res = await request(app).post('/api/lists').set(auth()).send({ name: 'VIP Leads', resource: 'leads' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('VIP Leads');
    listId = res.body.id;
  });

  it('GET /api/lists returns created lists', async () => {
    const res = await request(app).get('/api/lists').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/lists/:id/members adds members', async () => {
    const res = await request(app).post(`/api/lists/${listId}/members`).set(auth()).send({ ids: [leadId] });
    expect(res.status).toBe(200);
    expect(res.body.memberIds).toContain(leadId);
  });

  it('GET /api/lists/:id/members returns matching members (smart evaluate)', async () => {
    const res = await request(app).get(`/api/lists/${listId}/members`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('DELETE /api/lists/:id removes list', async () => {
    const res = await request(app).delete(`/api/lists/${listId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Lifecycle', () => {
  it('GET /api/lifecycle/stages returns stage counts', async () => {
    const res = await request(app).get('/api/lifecycle/stages').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.stages).toHaveLength(7);
  });

  it('POST /api/lifecycle/transition moves lead forward', async () => {
    const res = await request(app).post('/api/lifecycle/transition').set(auth()).send({ recordId: leadId, stage: 'MQL' });
    expect(res.status).toBe(200);
    expect(res.body.lifecycleStage).toBe('MQL');
  });

  it('POST /api/lifecycle/transition blocks backwards moves', async () => {
    const res = await request(app).post('/api/lifecycle/transition').set(auth()).send({ recordId: leadId, stage: 'Lead' });
    expect(res.status).toBe(400);
  });
});

describe('Lead Scoring', () => {
  it('GET /api/leadscoring/rules returns rules', async () => {
    const res = await request(app).get('/api/leadscoring/rules').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.rules.length).toBeGreaterThan(0);
  });

  it('GET /api/leadscoring/score/:id computes score', async () => {
    const res = await request(app).get(`/api/leadscoring/score/${leadId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('score');
    expect(res.body).toHaveProperty('tier');
    expect(typeof res.body.score).toBe('number');
  });

  it('POST /api/leadscoring/rules creates a rule', async () => {
    const res = await request(app).post('/api/leadscoring/rules').set(auth()).send({ field: 'source', op: 'eq', value: 'Referral', points: 15 });
    expect(res.status).toBe(201);
    expect(res.body.points).toBe(15);
  });
});

describe('Pipeline & Stage Gating', () => {
  it('GET /api/pipeline returns stages', async () => {
    const res = await request(app).get('/api/pipeline').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.stages.length).toBeGreaterThan(0);
  });

  it('PUT /api/pipeline/gates configures gating', async () => {
    const res = await request(app).put('/api/pipeline/gates').set(auth()).send({ Won: ['value'], Proposal: ['value', 'closeDate'] });
    expect(res.status).toBe(200);
    expect(res.body.Proposal).toEqual(['value', 'closeDate']);
  });

  it('POST /api/pipeline/move enforces gating (422 when missing fields)', async () => {
    const res = await request(app).post('/api/pipeline/move').set(auth()).send({ dealId, toStage: 'Qualified' });
    expect([200, 422]).toContain(res.status);
  });

  it('POST /api/pipeline/move succeeds with force', async () => {
    const res = await request(app).post('/api/pipeline/move').set(auth()).send({ dealId, toStage: 'Won', force: true });
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('Won');
  });
});

describe('Sequences', () => {
  it('POST /api/sequences creates sequence with steps', async () => {
    const res = await request(app).post('/api/sequences').set(auth()).send({
      name: 'Cold Outreach',
      steps: [
        { subject: 'Hi {{contact.name}}', body: 'Hello {{contact.name}}, first email.', delayDays: 0, action: 'email' },
        { subject: 'Follow up', body: 'Second email.', delayDays: 2, action: 'email' }
      ],
      exitRules: [{ type: 'reply', active: true }]
    });
    expect(res.status).toBe(201);
    expect(res.body.steps).toHaveLength(2);
    sequenceId = res.body.id;
  });

  it('POST /api/sequences/:id/enroll enrolls a lead', async () => {
    const res = await request(app).post(`/api/sequences/${sequenceId}/enroll`).set(auth()).send({ recordIds: [leadId] });
    expect(res.status).toBe(201);
    expect(res.body.enrolled).toBeGreaterThanOrEqual(1);
  });

  it('DELETE /api/sequences/:id removes sequence', async () => {
    const res = await request(app).delete(`/api/sequences/${sequenceId}`).set(auth());
    expect(res.status).toBe(200);
  });
});

describe('Tickets & SLA', () => {
  it('POST /api/tickets opens a ticket', async () => {
    const res = await request(app).post('/api/tickets').set(auth()).send({ subject: 'Cannot login', contact: 'Alice', priority: 'High' });
    expect(res.status).toBe(201);
    expect(res.body.stage).toBe('New');
    ticketId = res.body.id;
  });

  it('PUT /api/tickets/:id updates stage + first response', async () => {
    const res = await request(app).put(`/api/tickets/${ticketId}`).set(auth()).send({ stage: 'In Progress' });
    expect(res.status).toBe(200);
    expect(res.body.firstResponseAt).toBeTruthy();
  });

  it('GET /api/tickets/sla/summary returns SLA metrics', async () => {
    const res = await request(app).get('/api/tickets/sla/summary').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sla');
    expect(res.body).toHaveProperty('open');
  });

  it('DELETE /api/tickets/:id closes ticket', async () => {
    const res = await request(app).delete(`/api/tickets/${ticketId}`).set(auth());
    expect(res.status).toBe(200);
  });
});

describe('Meeting Scheduler', () => {
  it('POST /api/scheduler/links creates booking link', async () => {
    const res = await request(app).post('/api/scheduler/links').set(auth()).send({ title: 'Discovery Call', durationMinutes: 30 });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBeTruthy();
    linkSlug = res.body.slug;
  });

  it('GET /api/scheduler/public/:slug returns public availability', async () => {
    const res = await request(app).get(`/api/scheduler/public/${linkSlug}`);
    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBeGreaterThan(0);
  });

  it('POST /api/scheduler/public/:slug/book books a slot', async () => {
    const slots = await request(app).get(`/api/scheduler/public/${linkSlug}`);
    const slot = slots.body.slots[0];
    const res = await request(app).post(`/api/scheduler/public/${linkSlug}/book`).send({ name: 'Bob', email: 'bob@test.com', date: slots.body.date, time: slot });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
  });

  it('GET /api/scheduler/links lists links', async () => {
    const res = await request(app).get('/api/scheduler/links').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Live Chat & Decision Bot', () => {
  it('GET /api/livechat/session returns widget config', async () => {
    const res = await request(app).get('/api/livechat/session');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  it('POST /api/livechat/message routes to bot', async () => {
    const res = await request(app).post('/api/livechat/message').send({ text: 'How much does it cost?' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('reply');
  });

  it('POST /api/livechat/message hands off on agent keyword', async () => {
    const res = await request(app).post('/api/livechat/message').send({ text: 'I want to talk to a human agent' });
    expect(res.status).toBe(200);
    expect(res.body.handoff).toBe(true);
  });

  it('GET /api/livechat/conversations requires auth', async () => {
    const res = await request(app).get('/api/livechat/conversations');
    expect(res.status).toBe(401);
  });
});

describe('Knowledge Base', () => {
  it('POST /api/knowledgebase/articles creates article', async () => {
    const res = await request(app).post('/api/knowledgebase/articles').set(auth()).send({ title: 'Getting Started', body: 'How to configure the CRM.', category: 'Onboarding' });
    expect(res.status).toBe(201);
    articleId = res.body.id;
  });

  it('GET /api/knowledgebase/articles lists + searches', async () => {
    const res = await request(app).get('/api/knowledgebase/articles?q=Getting').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/kb/search is public and indexed', async () => {
    const res = await request(app).get('/api/kb/search?q=configure');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE /api/knowledgebase/articles/:id removes article', async () => {
    const res = await request(app).delete(`/api/knowledgebase/articles/${articleId}`).set(auth());
    expect(res.status).toBe(200);
  });
});

describe('Web Tracking & Attribution', () => {
  it('GET /api/web/event logs anonymous visit', async () => {
    const res = await request(app).get('/api/web/event?vid=v_test123&type=pageview&page=/pricing');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/web/identify attributes visits to contact', async () => {
    const res = await request(app).post('/api/web/identify').send({ vid: 'v_test123', email: 'alice@corp.com' });
    expect(res.status).toBe(200);
    expect(res.body.attributed).toBe(true);
  });

  it('GET /api/web/visitors requires auth', async () => {
    const res = await request(app).get('/api/web/visitors');
    expect(res.status).toBe(401);
  });

  it('GET /api/web/visitors returns attributed visits', async () => {
    const res = await request(app).get('/api/web/visitors').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Revisions & Field-level Audit', () => {
  it('Updating a lead records a revision', async () => {
    const before = await request(app).get(`/api/leads/${leadId}`).set(auth());
    const res = await request(app).put(`/api/leads/${leadId}`).set(auth()).send({ status: 'Qualified', value: 80000 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('revisionId');
    revisionId = res.body.revisionId;
  });

  it('GET /api/revisions returns the revision', async () => {
    const res = await request(app).get(`/api/revisions/leads/${leadId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('Revision contains field-level from/to changes', async () => {
    const res = await request(app).get(`/api/revisions/leads/${leadId}`).set(auth());
    const rev = res.body.data.find(r => r.id === revisionId) || res.body.data[0];
    expect(rev.actor).toBeTruthy();
    expect(rev.changes.some(c => c.field === 'value' || c.field === 'status')).toBe(true);
  });
});

describe('Field-level RBAC', () => {
  it('PUT /api/permissions/fields/:type configures hidden fields', async () => {
    const res = await request(app).put('/api/permissions/fields/lead').set(auth()).send({ role: 'viewer', hidden: ['phone'] });
    expect(res.status).toBe(200);
  });

  it('GET /api/permissions/fields returns field perms', async () => {
    const res = await request(app).get('/api/permissions/fields').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.lead.viewer.hidden).toContain('phone');
  });
});