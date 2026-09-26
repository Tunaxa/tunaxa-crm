import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import { query } from '../db/pg.js';

// Every assertion here proves a record reached Postgres. A response that could
// equally have come from the JSON store would pass even with the cutover
// reverted, so the tests read the tables back directly instead.
const TABLES = [
  'campaigns',
  'email_lists',
  'forms',
  'tickets',
  'surveys',
  'survey_responses',
];

const countRows = async (table) => {
  const { rows } = await query(`SELECT COUNT(*)::int AS total FROM ${table}`);
  return rows[0].total;
};

let app;
let token;

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
}, 30000);

afterAll(() => cleanupTestDb());

const auth = (req) => req.set('Authorization', `Bearer ${token}`);

// seedTestUser() leaves workspaceId off the record, so every row it creates falls
// back to the `default` tenant. These tests need a real tenant to prove the
// workspace is propagated and enforced rather than coincidentally matching.
async function seedTenantUser({ email, workspaceId, role = 'Owner' }) {
  const { mutateDb } = await import('../store.js');
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

const asUser = userToken => (req) => req.set('Authorization', `Bearer ${userToken}`);

describe('campaigns and email lists read Postgres', () => {
  it('POST /api/campaigns writes to the campaigns table and the JSON store stays empty', async () => {
    const res = await auth(request(app).post('/api/campaigns')).send({
      name: 'Spring Launch',
      channel: 'Email',
      status: 'Active',
      target: 100,
      reached: 40,
      leads: 8,
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Spring Launch');

    expect(await countRows('campaigns')).toBe(1);

    // A second read through the API must find the same row, which it can only do
    // if the list route is served by the repository.
    const list = await auth(request(app).get('/api/campaigns'));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(res.body.id);
  });

  it('GET /api/campaigns filters by status and channel in SQL', async () => {
    await auth(request(app).post('/api/campaigns')).send({
      name: 'Draft Campaign',
      channel: 'SMS',
      status: 'Draft',
    });

    const active = await auth(request(app).get('/api/campaigns?status=Active'));
    expect(active.body).toHaveLength(1);
    expect(active.body[0].name).toBe('Spring Launch');

    const sms = await auth(request(app).get('/api/campaigns?channel=SMS'));
    expect(sms.body).toHaveLength(1);
    expect(sms.body[0].name).toBe('Draft Campaign');
  });

  it('GET /api/marketing/summary aggregates the Postgres rows, not the JSON store', async () => {
    const res = await auth(request(app).get('/api/marketing/summary'));
    expect(res.status).toBe(200);
    // Two campaigns exist: one Active with target 100, one Draft.
    expect(res.body.campaigns).toBe(2);
    expect(res.body.active).toHaveLength(1);
    expect(res.body.totalTarget).toBe(100);
    expect(res.body.totalLeads).toBe(8);
  });

  it('POST /api/emailLists stores a numeric subscriber count', async () => {
    const res = await auth(request(app).post('/api/emailLists')).send({
      name: 'Newsletter',
      subscribers: '250',
      status: 'Active',
    });
    expect(res.status).toBe(201);
    expect(res.body.subscribers).toBe(250);

    const { rows } = await query('SELECT subscribers FROM email_lists WHERE id = $1', [
      res.body.id,
    ]);
    expect(rows[0].subscribers).toBe(250);
  });

  it('GET /api/marketing/summary counts the Postgres email list', async () => {
    const res = await auth(request(app).get('/api/marketing/summary'));
    expect(res.body.lists).toBe(1);
  });
});

describe('surveys and survey responses read Postgres', () => {
  it('POST /api/surveys round-trips the questions array', async () => {
    const res = await auth(request(app).post('/api/surveys')).send({
      name: 'NPS',
      type: 'NPS',
      status: 'Draft',
      question: 'How likely are you to recommend us?',
      targetScore: 9,
      questions: [{ key: 'score', type: 'number' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.questions).toEqual([{ key: 'score', type: 'number' }]);
    expect(res.body.targetScore).toBe(9);

    const { rows } = await query('SELECT questions, target_score FROM surveys WHERE id = $1', [
      res.body.id,
    ]);
    expect(rows[0].questions).toEqual([{ key: 'score', type: 'number' }]);
    expect(rows[0].target_score).toBe(9);
  });

  it('POST /api/surveyResponses round-trips the responses object and the score', async () => {
    const res = await auth(request(app).post('/api/surveyResponses')).send({
      survey: 'NPS',
      respondent: 'Jane',
      respondentEmail: 'jane@example.test',
      score: '9',
      responses: { score: 9, why: 'great' },
    });
    expect(res.status).toBe(201);
    expect(res.body.score).toBe(9);

    const { rows } = await query(
      'SELECT score, responses FROM survey_responses WHERE id = $1',
      [res.body.id],
    );
    expect(rows[0].score).toBe(9);
    expect(rows[0].responses).toEqual({ score: 9, why: 'great' });
  });

  it('GET /api/surveyResponses filters by survey name case-insensitively', async () => {
    const match = await auth(request(app).get('/api/surveyResponses?survey=nps'));
    expect(match.body).toHaveLength(1);

    const miss = await auth(request(app).get('/api/surveyResponses?survey=CSAT'));
    expect(miss.body).toHaveLength(0);
  });
});

describe('tickets are served by the ticket repository', () => {
  let ticketId;

  it('POST /api/tickets writes to Postgres and logs a Ticket activity', async () => {
    const res = await auth(request(app).post('/api/tickets')).send({
      subject: 'Checkout is broken',
      contact: 'Jane',
      contactEmail: 'jane@example.test',
      priority: 'High',
      description: 'Card rejected',
    });
    expect(res.status).toBe(201);
    expect(res.body.subject).toBe('Checkout is broken');
    expect(res.body.stage).toBe('New');
    ticketId = res.body.id;

    const { rows } = await query('SELECT subject, stage FROM tickets WHERE id = $1', [
      ticketId,
    ]);
    expect(rows[0].subject).toBe('Checkout is broken');
    expect(rows[0].stage).toBe('New');

    // The activity timeline is also a Postgres table, so a JSON-only activity
    // would be invisible to every activity view. `ticketId` is not a column on
    // activities, so legacyToPg files it in the custom_fields bag.
    const activities = await query(
      "SELECT title, type, custom_fields FROM activities WHERE type = 'Ticket'",
    );
    expect(activities.rows).toHaveLength(1);
    expect(activities.rows[0].title).toBe('Ticket opened: Checkout is broken');
    expect(activities.rows[0].type).toBe('Ticket');
    expect(activities.rows[0].custom_fields).toMatchObject({ ticketId });
  });

  it('GET /api/tickets keeps the envelope shape and counts stages', async () => {
    const res = await auth(request(app).get('/api/tickets'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.total).toBe(1);
    expect(res.body.sla).toEqual({ firstResponseHours: 4, resolutionHours: 48 });
    expect(res.body.stages).toEqual([
      { stage: 'New', count: 1 },
      { stage: 'In Progress', count: 0 },
      { stage: 'Awaiting Client', count: 0 },
      { stage: 'Resolved', count: 0 },
    ]);
    // Each row carries its SLA verdict.
    expect(res.body.data[0].sla).toEqual({
      status: 'active',
      firstResponse: 'pending',
      resolution: 'pending',
    });
  });

  it('PUT /api/tickets/:id stamps firstResponseAt when the stage leaves New', async () => {
    const res = await auth(request(app).put(`/api/tickets/${ticketId}`)).send({
      stage: 'In Progress',
    });
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('In Progress');
    expect(res.body.firstResponseAt).toBeTruthy();
  });

  it('PUT /api/tickets/:id does not restamp a timestamp a partial body omits', async () => {
    const before = await auth(request(app).get('/api/tickets'));
    const firstResponseAt = before.body.data[0].firstResponseAt;

    const res = await auth(request(app).put(`/api/tickets/${ticketId}`)).send({
      description: 'still broken',
    });
    expect(res.status).toBe(200);
    expect(res.body.firstResponseAt).toBe(firstResponseAt);
  });

  it('POST /api/tickets/:id/comment prepends and sets the first response once', async () => {
    const first = await auth(request(app).post(`/api/tickets/${ticketId}/comment`)).send({
      body: 'Looking into it',
    });
    expect(first.status).toBe(201);
    expect(first.body.comments[0].body).toBe('Looking into it');
    const firstResponseAt = first.body.firstResponseAt;

    const second = await auth(request(app).post(`/api/tickets/${ticketId}/comment`)).send({
      body: 'Found the bug',
    });
    // Newest first, matching the legacy unshift ordering.
    expect(second.body.comments[0].body).toBe('Found the bug');
    expect(second.body.comments[1].body).toBe('Looking into it');
    // COALESCE keeps the original first-response stamp.
    expect(second.body.firstResponseAt).toBe(firstResponseAt);

    const { rows } = await query('SELECT comments FROM tickets WHERE id = $1', [
      ticketId,
    ]);
    expect(rows[0].comments).toHaveLength(2);
    expect(rows[0].comments[0].body).toBe('Found the bug');
  });

  it('GET /api/tickets/sla/summary counts the open Postgres ticket', async () => {
    const res = await auth(request(app).get('/api/tickets/sla/summary'));
    expect(res.status).toBe(200);
    expect(res.body.open).toBe(1);
    expect(res.body.resolved).toBe(0);
    expect(res.body.ok).toBe(1);
  });

  it('PUT /api/tickets/:id resolves the ticket and the summary follows', async () => {
    const res = await auth(request(app).put(`/api/tickets/${ticketId}`)).send({
      stage: 'Resolved',
    });
    expect(res.status).toBe(200);
    expect(res.body.resolvedAt).toBeTruthy();
    expect(res.body.resolvedBy).toBe('Test User');

    const summary = await auth(request(app).get('/api/tickets/sla/summary'));
    expect(summary.body.open).toBe(0);
    expect(summary.body.resolved).toBe(1);
  });

  it('PUT /api/tickets/:id returns 404 for a missing ticket', async () => {
    const res = await auth(request(app).put('/api/tickets/does-not-exist')).send({
      stage: 'New',
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/tickets/:id removes the row', async () => {
    const res = await auth(request(app).delete(`/api/tickets/${ticketId}`));
    expect(res.status).toBe(200);
    expect(await countRows('tickets')).toBe(0);

    const again = await auth(request(app).delete(`/api/tickets/${ticketId}`));
    expect(again.status).toBe(404);
  });
});

describe('forms are served by the form repository', () => {
  const permalink = 'demo-form';
  let formId;

  const createForm = (overrides = {}) =>
    auth(request(app).post('/api/forms')).send({
      name: 'Demo Form',
      permalink,
      submitTo: 'lead',
      fields: [
        { key: 'name', label: 'Name', required: true },
        { key: 'email', label: 'Email', type: 'email', required: true },
        { key: 'phone', label: 'Phone' },
      ],
      ...overrides,
    });

  it('POST /api/forms persists to Postgres with the fields array intact', async () => {
    const res = await createForm();
    expect(res.status).toBe(201);
    expect(res.body.permalink).toBe(permalink);
    expect(res.body.submissionCount).toBe(0);
    formId = res.body.id;

    const { rows } = await query('SELECT name, fields, enabled FROM forms WHERE id = $1', [
      formId,
    ]);
    expect(rows[0].name).toBe('Demo Form');
    expect(rows[0].enabled).toBe(true);
    expect(rows[0].fields).toHaveLength(3);
    expect(rows[0].fields[0].key).toBe('name');
  });

  it('POST /api/forms rejects a duplicate permalink', async () => {
    const res = await createForm();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/permalink/i);
  });

  it('GET /api/forms/:permalink is public and returns the fields', async () => {
    const res = await request(app).get(`/api/forms/${permalink}`);
    expect(res.status).toBe(200);
    expect(res.body.form.name).toBe('Demo Form');
    expect(res.body.form.fields).toHaveLength(3);
    expect(res.body.form.fields[0].label).toBe('Name');
  });

  it('GET /api/forms/:permalink 404s for an unknown permalink', async () => {
    const res = await request(app).get('/api/forms/no-such-form');
    expect(res.status).toBe(404);
  });

  it('POST submit creates a lead in Postgres and counts the submission', async () => {
    const res = await request(app).post(`/api/forms/${permalink}/submit`).send({
      name: 'Jane Doe',
      email: 'jane@example.test',
    });
    expect(res.status).toBe(201);
    expect(res.body.existing).toBe(false);
    expect(res.body.form).toBe(permalink);

    // The lead must be in Postgres, not the JSON store.
    const { rows } = await query('SELECT first_name, last_name, email FROM leads WHERE id = $1', [
      res.body.recordId,
    ]);
    expect(rows[0].first_name).toBe('Jane');
    expect(rows[0].last_name).toBe('Doe');
    expect(rows[0].email).toBe('jane@example.test');

    const { rows: counter } = await query(
      'SELECT submission_count FROM forms WHERE id = $1',
      [formId],
    );
    expect(counter[0].submission_count).toBe(1);
  });

  it('a second submission updates the same lead rather than duplicating it', async () => {
    // `name` is still required: progressive profiling only relaxes a field when
    // the caller sends the recordId it is resuming, and this submission does not.
    const res = await request(app).post(`/api/forms/${permalink}/submit`).send({
      name: 'Jane Doe',
      email: 'jane@example.test',
      phone: '555-0100',
    });
    expect(res.status).toBe(201);
    expect(res.body.existing).toBe(true);

    const { rows } = await query('SELECT phone FROM leads WHERE id = $1', [
      res.body.recordId,
    ]);
    expect(rows[0].phone).toBe('555-0100');
    // Still exactly one lead, so the exact-email lookup did not fuzzy-match a
    // second record into existence.
    expect(await countRows('leads')).toBe(1);

    const { rows: counter } = await query(
      'SELECT submission_count FROM forms WHERE id = $1',
      [formId],
    );
    expect(counter[0].submission_count).toBe(2);
  });

  it('a submission logs a Form activity in Postgres', async () => {
    const { rows } = await query(
      "SELECT title, type FROM activities WHERE type = 'Form' ORDER BY created_at",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('Submitted form: Demo Form');
    expect(rows[1].title).toBe('Updated via form: Demo Form');
  });

  it('submit enforces required fields', async () => {
    const res = await request(app).post(`/api/forms/${permalink}/submit`).send({
      email: 'nobody@example.test',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('a submission does not restamp the form modified time', async () => {
    const before = await query('SELECT updated_at FROM forms WHERE id = $1', [formId]);
    const beforeTime = new Date(before.rows[0].updated_at).getTime();

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await request(app).post(`/api/forms/${permalink}/submit`).send({
      name: 'Jane Doe',
      email: 'jane@example.test',
    });

    const after = await query('SELECT updated_at, submission_count FROM forms WHERE id = $1', [
      formId,
    ]);
    // Migration 008 gives forms its own trigger so a counter-only update keeps
    // the original updated_at.
    expect(new Date(after.rows[0].updated_at).getTime()).toBe(beforeTime);
    expect(after.rows[0].submission_count).toBe(3);
  });

  it('a real edit does restamp the form modified time', async () => {
    const before = await query('SELECT updated_at FROM forms WHERE id = $1', [formId]);
    const beforeTime = new Date(before.rows[0].updated_at).getTime();

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const res = await auth(request(app).put(`/api/forms/${formId}`)).send({
      description: 'Updated copy',
    });
    expect(res.status).toBe(200);

    const after = await query('SELECT updated_at FROM forms WHERE id = $1', [formId]);
    expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThan(beforeTime);
  });

  it('PUT /api/forms/:id can disable a form, which hides it from the public route', async () => {
    const res = await auth(request(app).put(`/api/forms/${formId}`)).send({
      enabled: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);

    // A disabled form must be invisible to the unauthenticated render endpoint.
    const view = await request(app).get(`/api/forms/${permalink}`);
    expect(view.status).toBe(404);

    const submit = await request(app).post(`/api/forms/${permalink}/submit`).send({
      name: 'Jane',
      email: 'jane@example.test',
    });
    expect(submit.status).toBe(404);

    const { rows: counter } = await query(
      'SELECT submission_count FROM forms WHERE id = $1',
      [formId],
    );
    expect(counter[0].submission_count).toBe(3);
  });

  it('GET /api/forms lists the Postgres rows', async () => {
    const res = await auth(request(app).get('/api/forms'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].id).toBe(formId);
  });

  it('GET /api/forms?enabled=false finds the disabled form', async () => {
    const res = await auth(request(app).get('/api/forms?enabled=false'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].id).toBe(formId);
  });

  it('DELETE /api/forms/:id removes the row', async () => {
    const res = await auth(request(app).delete(`/api/forms/${formId}`));
    expect(res.status).toBe(200);
    expect(await countRows('forms')).toBe(0);

    const again = await auth(request(app).delete(`/api/forms/${formId}`));
    expect(again.status).toBe(404);
  });
});

describe('a form targeting contacts writes to the contacts table', () => {
  it('submits into contacts and stores non-column fields as custom fields', async () => {
    const permalink = 'contact-form';
    const created = await auth(request(app).post('/api/forms')).send({
      name: 'Contact Form',
      permalink,
      submitTo: 'contact',
      fields: [
        { key: 'name', label: 'Name', required: true },
        { key: 'email', label: 'Email', type: 'email', required: true },
        { key: 'interest', label: 'Interest' },
      ],
    });
    expect(created.status).toBe(201);

    const res = await request(app).post(`/api/forms/${permalink}/submit`).send({
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      interest: 'Analytics',
    });
    expect(res.status).toBe(201);
    expect(res.body.existing).toBe(false);

    const { rows } = await query(
      'SELECT first_name, last_name, email, custom_fields FROM contacts WHERE id = $1',
      [res.body.recordId],
    );
    expect(rows[0].first_name).toBe('Ada');
    expect(rows[0].last_name).toBe('Lovelace');
    expect(rows[0].email).toBe('ada@example.test');
    // `interest` is not a contacts column, so legacyToPg's generic path would
    // drop it unless the route files it under custom_fields.
    expect(rows[0].custom_fields).toMatchObject({ interest: 'Analytics' });
  });
});

describe('the customer portal serves tickets from Postgres', () => {
  it('returns the ticket for a matching contact email', async () => {
    const ticket = await auth(request(app).post('/api/tickets')).send({
      subject: 'Portal visibility',
      contactEmail: 'portal@example.test',
    });
    expect(ticket.status).toBe(201);

    const res = await request(app)
      .post('/api/portal/access')
      .send({ email: 'portal@example.test' });
    expect(res.status).toBe(200);
    // loadRows() reads tickets from the repository now that PG_RESOURCES
    // includes it; the JSON store holds none. The match runs on contactEmail,
    // which is the field a ticket actually stores the requester in.
    expect(res.body.tickets).toHaveLength(1);
    expect(res.body.tickets[0].subject).toBe('Portal visibility');
  });
});

describe('PUT /api/tickets/sla is not shadowed by PUT /api/tickets/:id', () => {
  it('updates the SLA targets instead of treating "sla" as a ticket id', async () => {
    const res = await auth(request(app).put('/api/tickets/sla')).send({
      firstResponseHours: 2,
      resolutionHours: 24,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ firstResponseHours: 2, resolutionHours: 24 });

    const read = await auth(request(app).get('/api/tickets'));
    expect(read.body.sla).toEqual({ firstResponseHours: 2, resolutionHours: 24 });
  });
});

describe('workspace isolation', () => {
  let acmeToken;
  let globexToken;

  beforeAll(async () => {
    acmeToken = await seedTenantUser({ email: 'acme@test.com', workspaceId: 'ws_acme' });
    globexToken = await seedTenantUser({ email: 'globex@test.com', workspaceId: 'ws_globex' });
  });

  it('files a created form and ticket under the creating user workspace', async () => {
    const form = await asUser(acmeToken)(request(app).post('/api/forms')).send({
      name: 'Acme Intake',
      permalink: 'acme-intake',
      // Only declared fields are captured, so the email field has to exist for
      // the same-email isolation check below to have anything to match on.
      fields: [
        { key: 'name', label: 'Name' },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Phone' },
      ],
    });
    expect(form.status).toBe(201);
    // workspace_id is a `hidden` mapping column, so it is absent from the
    // response and has to be read back from the table to be verified.
    expect(form.body.workspace_id).toBeUndefined();
    const { rows } = await query('SELECT workspace_id FROM forms WHERE id = $1', [form.body.id]);
    expect(rows[0].workspace_id).toBe('ws_acme');

    const ticket = await asUser(globexToken)(request(app).post('/api/tickets')).send({
      subject: 'Globex outage',
    });
    expect(ticket.status).toBe(201);
    const { rows: t } = await query('SELECT workspace_id FROM tickets WHERE id = $1', [
      ticket.body.id,
    ]);
    expect(t[0].workspace_id).toBe('ws_globex');
  });

  it('files a public submission, its activity and the ticket in the form workspace', async () => {
    // The submitter is anonymous, so the form's own workspace is the only tenant
    // the new lead can belong to.
    const res = await request(app).post('/api/forms/acme-intake/submit').send({
      name: 'Ada Lovelace',
      email: 'ada@acme.test',
    });
    expect(res.status).toBe(201);
    expect(res.body.existing).toBe(false);

    const { rows: lead } = await query('SELECT workspace_id FROM leads WHERE id = $1', [
      res.body.recordId,
    ]);
    expect(lead[0].workspace_id).toBe('ws_acme');

    const { rows: act } = await query(
      "SELECT workspace_id FROM activities WHERE type = 'Form' AND record_id = $1",
      [res.body.recordId],
    );
    expect(act).toHaveLength(1);
    expect(act[0].workspace_id).toBe('ws_acme');
  });

  it('does not let one workspace overwrite a same-email record in another', async () => {
    // Ada already exists in ws_acme. A form owned by a different workspace
    // submitting the same address must create its own record, not mutate hers.
    const form = await asUser(globexToken)(request(app).post('/api/forms')).send({
      name: 'Globex Intake',
      permalink: 'globex-intake',
      fields: [
        { key: 'name', label: 'Name' },
        { key: 'email', label: 'Email' },
      ],
    });
    expect(form.status).toBe(201);

    const res = await request(app).post('/api/forms/globex-intake/submit').send({
      name: 'Ada From Globex',
      email: 'ada@acme.test',
    });
    expect(res.status).toBe(201);
    // No match in ws_globex, so a new record is created rather than the ws_acme
    // one being overwritten.
    expect(res.body.existing).toBe(false);
    expect(res.body.recordId).not.toBe(
      (await query('SELECT id FROM leads WHERE email = $1 AND workspace_id = $2', [
        'ada@acme.test',
        'ws_acme',
      ])).rows[0].id,
    );

    // Both tenants keep their own record, unmodified.
    const { rows } = await query(
      'SELECT workspace_id, first_name FROM leads WHERE email = $1 ORDER BY workspace_id',
      ['ada@acme.test'],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.workspace_id).sort()).toEqual(['ws_acme', 'ws_globex']);
    const acme = rows.find(r => r.workspace_id === 'ws_acme');
    expect(acme.first_name).toBe('Ada');
  });

  it('ignores a recordId belonging to another workspace', async () => {
    const { rows } = await query(
      'SELECT id FROM leads WHERE workspace_id = $1 AND email = $2',
      ['ws_globex', 'ada@acme.test'],
    );
    const globexLeadId = rows[0].id;

    // A visitor hands the Acme form a Globex record id. Without the workspace
    // filter that lead would be read (revealing which fields are filled) and
    // then overwritten by the submission.
    const render = await request(app).get(
      `/api/forms/acme-intake?recordId=${globexLeadId}`,
    );
    expect(render.status).toBe(200);
    // The foreign record is not treated as "known", so nothing is hidden even
    // though the same address and name are filled in the other workspace.
    expect(render.body.form.fields.map(f => f.key)).toEqual(
      expect.arrayContaining(['name', 'email']),
    );

    const submit = await request(app).post('/api/forms/acme-intake/submit').send({
      recordId: globexLeadId,
      name: 'Mallory',
      email: 'mallory@acme.test',
    });
    expect(submit.status).toBe(201);
    // A fresh lead rather than an update of the Globex record.
    expect(submit.body.existing).toBe(false);
    expect(submit.body.recordId).not.toBe(globexLeadId);

    const { rows: untouched } = await query('SELECT first_name FROM leads WHERE id = $1', [
      globexLeadId,
    ]);
    expect(untouched[0].first_name).toBe('Ada');
  });
});

describe('form submissions do not pollute custom fields', () => {
  const permalink = 'clean-form';

  beforeAll(async () => {
    await auth(request(app).post('/api/forms')).send({
      name: 'Clean Form',
      permalink,
      fields: [
        { key: 'name', label: 'Name' },
        { key: 'email', label: 'Email' },
        { key: 'plan', label: 'Plan' },
      ],
    });
  });

  it('keeps id and timestamps out of the bag and stores the form metadata in it', async () => {
    const res = await request(app).post(`/api/forms/${permalink}/submit`).send({
      name: 'Grace Hopper',
      email: 'grace@example.test',
      plan: 'pro',
    });
    expect(res.status).toBe(201);

    const { rows } = await query('SELECT custom_fields FROM leads WHERE id = $1', [
      res.body.recordId,
    ]);
    const bag = rows[0].custom_fields;
    // genericLegacyToPg passes `id` through and the split helper used to bucket
    // it, so the bag would claim a visitor filled in a field called "id".
    expect(bag).not.toHaveProperty('id');
    expect(bag).not.toHaveProperty('createdAt');
    expect(bag).not.toHaveProperty('updatedAt');
    expect(bag).toMatchObject({ plan: 'pro', lifecycleStage: 'Lead' });
  });

  it('preserves custom fields a later partial submission does not carry', async () => {
    // A second visitor on the same address submits only a name. The JSON handler
    // merged into the record, so the stored `plan` had to survive.
    const res = await request(app).post(`/api/forms/${permalink}/submit`).send({
      name: 'Grace Hopper',
      email: 'grace@example.test',
    });
    expect(res.status).toBe(201);
    expect(res.body.existing).toBe(true);

    const { rows } = await query('SELECT custom_fields FROM leads WHERE id = $1', [
      res.body.recordId,
    ]);
    expect(rows[0].custom_fields).toMatchObject({ plan: 'pro' });
  });
});
