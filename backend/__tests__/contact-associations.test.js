import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import { mutateDb } from '../store.js';

// Fixtures are written straight into the store so each linking convention can be
// exercised in isolation: a company-name link, an explicit contactId, an explicit
// recordId, and a plain-name `contact` string.
const at = '2026-10-01T00:00:00.000Z';

const FIXTURES = {
  contacts: [
    { id: 'contact_acme', name: 'Alice Miller', email: 'alice@northwind.com', phone: '+1-212-555-0173', company: 'Northwind Traders', createdAt: at, updatedAt: at },
    { id: 'contact_bob', name: 'Bob Carter', email: 'bob@northwind.com', phone: '+1-212-555-0184', company: 'Northwind Traders', createdAt: at, updatedAt: at },
    { id: 'contact_zoe', name: 'Zoe Lone', email: 'zoe@nowhere.test', createdAt: at, updatedAt: at },
    // Deliberately unrelated to every fixture, so the empty-relations case does
    // not depend on which other fixtures happen to exist.
    { id: 'contact_solo', name: 'Solita Person', email: 'solo@isolated.test', createdAt: at, updatedAt: at },
  ],
  companies: [
    { id: 'company_northwind', name: 'Northwind Traders', industry: 'Retail', createdAt: at, updatedAt: at },
    { id: 'company_globex', name: 'Globex Logistics', industry: 'Logistics', createdAt: at, updatedAt: at },
  ],
  deals: [
    // Linked by company name.
    { id: 'deal_rollout', title: 'Enterprise CRM rollout', company: 'Northwind Traders', value: 48000, stage: 'proposal', createdAt: at, updatedAt: at },
    // Linked by a plain-name `contact` string.
    { id: 'deal_advisory', title: 'Advisory retainer', contact: 'Alice Miller', value: 5000, stage: 'new', createdAt: at, updatedAt: at },
    // Belongs to another company, and to another person.
    { id: 'deal_globex', title: 'Logistics automation', company: 'Globex Logistics', value: 39000, stage: 'qualified', createdAt: at, updatedAt: at },
    { id: 'deal_zoe', title: 'Unrelated retainer', contact: 'Zoe Lone', value: 100, stage: 'new', createdAt: at, updatedAt: at },
  ],
  tasks: [
    // Linked by explicit contactId.
    { id: 'task_followup', title: 'Send revised quote', contactId: 'contact_acme', status: 'Open', createdAt: at, updatedAt: at },
    // Linked by a contactIds mapping array.
    { id: 'task_intake', title: 'Complete onboarding', contactIds: ['contact_acme', 'contact_bob'], status: 'Open', createdAt: at, updatedAt: at },
    // Unrelated, and must not leak into anybody's group.
    { id: 'task_global', title: 'Archive stale records', status: 'Open', createdAt: at, updatedAt: at },
  ],
  activities: [
    // Meetings live in activities, and the store capitalises the type either way.
    { id: 'act_meeting_email', title: 'Quarterly pricing', type: 'Meeting', contact: 'alice@northwind.com', createdAt: at, updatedAt: at },
    { id: 'act_meeting_recordid', title: 'Renewal', type: 'meeting', recordId: 'contact_acme', createdAt: at, updatedAt: at },
    // Other activity types for the same contact, which are not meetings.
    { id: 'act_email', title: 'POC overview', type: 'Email', contact: 'alice@northwind.com', createdAt: at, updatedAt: at },
    { id: 'act_note', title: 'Left voicemail', type: 'Note', recordId: 'contact_acme', createdAt: at, updatedAt: at },
    // Another person's meeting.
    { id: 'act_meeting_zoe', title: 'Intro call', type: 'Meeting', contact: 'Zoe Lone', createdAt: at, updatedAt: at },
  ],
};

let app;
let token;

const getAssociations = (id, auth = true) => {
  const req = request(app).get(`/api/contacts/${id}/associations`);
  if (auth) req.set('Authorization', `Bearer ${token}`);
  return req;
};

const idsOf = (rows) => rows.map((row) => row.id);

// The shared setup hook spawns `npm run migrate`, and importing the server pulls
// in every route module. On a cold module cache that can exceed vitest's 10s
// default, so this hook gets an explicit budget rather than flaking in CI.
beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);

  await mutateDb((db) => {
    for (const [key, rows] of Object.entries(FIXTURES)) {
      db[key] = [...(db[key] || []), ...rows];
    }
  });
}, 60_000);

afterAll(() => cleanupTestDb());

describe('GET /api/contacts/:id/associations', () => {
  it('requires authentication', async () => {
    const res = await getAssociations('contact_acme', false);
    expect(res.status).toBe(401);
  });

  it('rejects a session token that is not valid', async () => {
    const res = await request(app)
      .get('/api/contacts/contact_acme/associations')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('returns every group for a contact that has relations', async () => {
    const res = await getAssociations('contact_acme');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.companies)).toBe(true);
    expect(Array.isArray(res.body.deals)).toBe(true);
    expect(Array.isArray(res.body.tasks)).toBe(true);
    expect(Array.isArray(res.body.meetings)).toBe(true);

    expect(res.body.companies).toHaveLength(1);
    expect(res.body.deals).toHaveLength(2);
    expect(res.body.tasks).toHaveLength(2);
    expect(res.body.meetings).toHaveLength(2);
  });

  it('groups companies by the name on the contact', async () => {
    const res = await getAssociations('contact_acme');

    expect(idsOf(res.body.companies)).toEqual(['company_northwind']);
    expect(res.body.companies[0].name).toBe('Northwind Traders');
  });

  it('groups deals linked by company name and by contact name', async () => {
    const res = await getAssociations('contact_acme');

    expect(idsOf(res.body.deals).sort()).toEqual(['deal_advisory', 'deal_rollout']);
  });

  it('groups tasks linked by contactId and by a contactIds mapping array', async () => {
    const res = await getAssociations('contact_acme');

    expect(idsOf(res.body.tasks).sort()).toEqual(['task_followup', 'task_intake']);
  });

  it('groups meetings by contact email and by recordId', async () => {
    const res = await getAssociations('contact_acme');

    expect(idsOf(res.body.meetings).sort()).toEqual(['act_meeting_email', 'act_meeting_recordid']);
  });

  it('excludes other contacts\' records from every group', async () => {
    const res = await getAssociations('contact_acme');
    const everything = [
      ...idsOf(res.body.companies),
      ...idsOf(res.body.deals),
      ...idsOf(res.body.tasks),
      ...idsOf(res.body.meetings),
    ];

    for (const foreign of ['company_globex', 'deal_globex', 'deal_zoe', 'act_meeting_zoe']) {
      expect(everything).not.toContain(foreign);
    }
  });

  it('does not return unlinked records', async () => {
    const res = await getAssociations('contact_acme');
    const everything = [
      ...idsOf(res.body.companies),
      ...idsOf(res.body.deals),
      ...idsOf(res.body.tasks),
      ...idsOf(res.body.meetings),
    ];

    expect(everything).not.toContain('task_global');
  });

  it('returns only activities typed as a meeting', async () => {
    const res = await getAssociations('contact_acme');
    const meetings = idsOf(res.body.meetings);

    expect(meetings).not.toContain('act_email');
    expect(meetings).not.toContain('act_note');
    expect(res.body.meetings.every((row) => String(row.type).toLowerCase() === 'meeting')).toBe(true);
  });

  it('shares company-level relations but not person-level ones', async () => {
    const res = await getAssociations('contact_bob');

    // Same company as Alice, so the company and its deals are shared.
    expect(idsOf(res.body.companies)).toEqual(['company_northwind']);
    expect(idsOf(res.body.deals)).toEqual(['deal_rollout']);

    // Alice's personal records must not appear.
    expect(idsOf(res.body.deals)).not.toContain('deal_advisory');
    expect(idsOf(res.body.meetings)).toEqual([]);

    // task_intake references Bob through a mapping array.
    expect(idsOf(res.body.tasks)).toEqual(['task_intake']);
  });

  it('returns empty arrays for a contact with no relations', async () => {
    const res = await getAssociations('contact_solo');

    expect(res.status).toBe(200);
    expect(res.body.companies).toEqual([]);
    expect(res.body.deals).toEqual([]);
    expect(res.body.tasks).toEqual([]);
    expect(res.body.meetings).toEqual([]);
  });

  it('does not leak another contact\'s records into an unlinked contact', async () => {
    const res = await getAssociations('contact_solo');

    for (const foreign of ['deal_zoe', 'deal_advisory', 'act_meeting_zoe', 'deal_rollout']) {
      expect(JSON.stringify(res.body)).not.toContain(foreign);
    }
  });

  it('returns the four groups as keys and nothing else', async () => {
    const res = await getAssociations('contact_acme');

    expect(Object.keys(res.body).sort()).toEqual(['companies', 'deals', 'meetings', 'tasks']);
  });

  it('returns 404 for a contact that does not exist', async () => {
    const res = await getAssociations('contact_missing');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Contact not found');
  });

  it('returns 404 rather than an empty payload for a missing contact', async () => {
    const res = await getAssociations('contact_missing');

    expect(res.body.companies).toBeUndefined();
    expect(res.body.deals).toBeUndefined();
    expect(res.body.tasks).toBeUndefined();
    expect(res.body.meetings).toBeUndefined();
  });

  it('does not match another resource id', async () => {
    const res = await getAssociations('company_northwind');

    expect(res.status).toBe(404);
  });

  it('matches the company name case-insensitively', async () => {
    await mutateDb((db) => {
      db.contacts.push({
        id: 'contact_case',
        name: 'Casey Lower',
        email: 'casey@northwind.com',
        company: '  northwind TRADERS  ',
        createdAt: at,
        updatedAt: at,
      });
    });

    const res = await getAssociations('contact_case');

    expect(res.status).toBe(200);
    expect(idsOf(res.body.companies)).toEqual(['company_northwind']);
    expect(idsOf(res.body.deals)).toEqual(['deal_rollout']);
  });

  it('tolerates a contact with no company, email, or phone', async () => {
    await mutateDb((db) => {
      db.contacts.push({ id: 'contact_bare', name: 'Bare Minimum', createdAt: at, updatedAt: at });
    });

    const res = await getAssociations('contact_bare');

    expect(res.status).toBe(200);
    expect(res.body.companies).toEqual([]);
    expect(res.body.deals).toEqual([]);
    expect(res.body.tasks).toEqual([]);
    expect(res.body.meetings).toEqual([]);
  });

  it('does not shadow the generic contact resource route', async () => {
    const created = await request(app).post('/api/contacts')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Alice Miller', email: 'alice@acme.test' });
    expect(created.status).toBe(201);
    const res = await request(app)
      .get(`/api/contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Alice Miller');
  });

  it('finds associated records created through PostgreSQL-backed CRUD', async () => {
    const create = async (resource, body) => {
      const res = await request(app).post(`/api/${resource}`)
        .set('Authorization', `Bearer ${token}`).send(body);
      expect(res.status).toBe(201);
      return res.body;
    };
    const company = await create('companies', { name: 'PG Association Company' });
    const contact = await create('contacts', { name: 'PG Contact', email: 'pg@association.test', company: company.name });
    const deal = await create('deals', { title: 'PG Deal', company: company.name, contactId: contact.id, stage: 'New' });
    const task = await create('tasks', { title: 'PG Task', contactId: contact.id, status: 'Open' });
    const res = await getAssociations(contact.id);
    expect(res.status).toBe(200);
    expect(idsOf(res.body.companies)).toContain(company.id);
    expect(idsOf(res.body.deals)).toContain(deal.id);
    expect(idsOf(res.body.tasks)).toContain(task.id);
  });
});
