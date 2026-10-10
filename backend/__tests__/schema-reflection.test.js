import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { closePool } from '../db/pg.js';
import { resetTestDb, seedTestUser, loginAs } from './setup.js';

// The Schema Reflection API is the contract a UI uses to render forms, tables
// and validations without hardcoding field definitions. These tests pin both the
// per-field minimum contract and the pieces that must stay wired to the real
// entity models (ticket stages, SLA priorities, deal pipelines, custom fields).

let app;
let token;

const RESOURCES = [
  'contacts',
  'leads',
  'companies',
  'deals',
  'tickets',
  'quotes',
  'tasks',
  'activities',
];

// Every field must carry at least these attributes for a form generator to work.
const REQUIRED_FIELD_ATTRS = ['name', 'key', 'label', 'type', 'required', 'readOnly'];

const getSchema = (resource) =>
  request(app)
    .get(`/api/schema/${resource}`)
    .set('Authorization', `Bearer ${token}`);

const byName = (fields) =>
  Object.fromEntries(fields.map((field) => [field.name, field]));

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

describe('GET /api/schema/:resource', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/schema/tickets');
    expect(res.status).toBe(401);
  });

  it('returns 404 with a helpful message for an unknown resource', async () => {
    const res = await getSchema('nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown resource/i);
    expect(res.body.error).toContain('tickets');
  });

  it('describes every supported resource with the minimum field contract', async () => {
    for (const resource of RESOURCES) {
      const res = await getSchema(resource);
      expect(res.status).toBe(200);
      expect(res.body.object).toBe(resource);
      expect(res.body.resource).toBe(resource);
      expect(res.body.primaryKey).toBe('id');
      expect(typeof res.body.label).toBe('string');
      expect(Array.isArray(res.body.fields)).toBe(true);
      expect(res.body.fields.length).toBeGreaterThan(0);

      for (const field of res.body.fields) {
        for (const attr of REQUIRED_FIELD_ATTRS) {
          expect(field, `${resource}.${field.name} missing ${attr}`).toHaveProperty(attr);
        }
        expect(typeof field.name).toBe('string');
        expect(field.name.length).toBeGreaterThan(0);
        expect(typeof field.key).toBe('string');
        expect(field.key).toBe(field.name);
        expect(typeof field.label).toBe('string');
        expect(typeof field.type).toBe('string');
        expect(typeof field.required).toBe('boolean');
        expect(typeof field.readOnly).toBe('boolean');
      }
    }
  });

  it('marks the system-managed fields read-only on every resource', async () => {
    for (const resource of RESOURCES) {
      const res = await getSchema(resource);
      const fields = byName(res.body.fields);
      expect(fields.id.readOnly).toBe(true);
      expect(fields.createdAt.readOnly).toBe(true);
      expect(fields.updatedAt.readOnly).toBe(true);
    }
  });
});

describe('ticket schema', () => {
  it('offers the Kanban stage and SLA priority as select options', async () => {
    const res = await getSchema('tickets');
    const fields = byName(res.body.fields);

    const stage = fields.stage;
    expect(stage.type).toBe('select');
    expect(stage.options.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        'New',
        'In Progress',
        'Awaiting Client',
        'Resolved',
        'Closed',
      ]),
    );

    const priority = fields.priority;
    expect(priority.type).toBe('select');
    expect(priority.options.map((option) => option.value)).toEqual(
      expect.arrayContaining(['Low', 'Normal', 'Medium', 'High', 'Urgent']),
    );

    // The option contract is { label, value }, not a bare string.
    for (const option of stage.options) {
      expect(option).toHaveProperty('label');
      expect(option).toHaveProperty('value');
    }
  });

  it('marks the SLA/system-managed fields read-only and the subject required', async () => {
    const res = await getSchema('tickets');
    const fields = byName(res.body.fields);
    expect(fields.subject.required).toBe(true);
    expect(fields.closedAt.readOnly).toBe(true);
    expect(fields.stageHistory.readOnly).toBe(true);
    expect(fields.slaBreached.readOnly).toBe(true);
    expect(fields.slaDueAt.readOnly).toBe(true);
  });
});

describe('contact schema', () => {
  it('exposes the core fields with labels and types', async () => {
    const res = await getSchema('contacts');
    expect(res.status).toBe(200);
    const fields = byName(res.body.fields);

    expect(fields.firstName).toMatchObject({ label: 'First Name', type: 'string' });
    expect(fields.lastName).toMatchObject({ label: 'Last Name', type: 'string' });
    expect(fields.email.type).toBe('email');
    expect(fields.phone.type).toBe('string');
    expect(fields.phone).toHaveProperty('required');
    expect(fields.firstName.readOnly).toBe(false);
  });

  it('round-trips schema-generated firstName/lastName into the real columns', async () => {
    const created = await request(app)
      .post('/api/contacts')
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com' });
    expect(created.status).toBe(201);
    expect(created.body.first_name).toBe('Grace');
    expect(created.body.last_name).toBe('Hopper');
    expect(created.body.name).toBe('Grace Hopper');
  });
});

describe('deal schema', () => {
  it('returns stage options, the workspace currency and the value field', async () => {
    const res = await getSchema('deals');
    expect(res.status).toBe(200);
    expect(typeof res.body.currency).toBe('string');
    expect(res.body.currency.length).toBeGreaterThan(0);

    const fields = byName(res.body.fields);
    expect(fields.value).toMatchObject({ type: 'number', format: 'currency' });
    expect(fields.stage.type).toBe('select');
    expect(fields.stage.options.length).toBeGreaterThan(0);
    expect(fields.title.required).toBe(true);
  });

  it('reflects a workspace pipeline definition dynamically', async () => {
    const create = await request(app)
      .post('/api/pipeline/definitions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Reflection Pipeline',
        stages: [
          { key: 'discovery', label: 'Discovery', probability: 20, order: 0 },
          { key: 'closed_won', label: 'Won', probability: 100, order: 1 },
        ],
      });
    expect(create.status).toBe(201);

    const res = await getSchema('deals');
    const fields = byName(res.body.fields);
    const values = fields.stage.options.map((option) => option.value);
    expect(values).toContain('discovery');
    expect(values).toContain('closed_won');

    const pipelineValues = fields.pipelineId.options.map((option) => option.value);
    expect(pipelineValues).toContain(create.body.id);
  });
});

describe('custom fields', () => {
  it('merges per-object custom fields into the reflection payload', async () => {
    const create = await request(app)
      .post('/api/customFields')
      .set('Authorization', `Bearer ${token}`)
      .send({
        object: 'Contact',
        key: 'loyaltyTier',
        name: 'Loyalty Tier',
        type: 'Dropdown',
        options: 'Gold, Silver, Bronze',
      });
    expect(create.status).toBe(201);

    const res = await getSchema('contacts');
    const field = res.body.fields.find((item) => item.name === 'loyaltyTier');
    expect(field).toBeDefined();
    expect(field.custom).toBe(true);
    expect(field.label).toBe('Loyalty Tier');
    expect(field.type).toBe('select');
    expect(field.options.map((option) => option.value)).toEqual([
      'Gold',
      'Silver',
      'Bronze',
    ]);

    // The legacy projection kept for the existing custom-field form consumer.
    expect(res.body.customFields.map((item) => item.key)).toContain('loyaltyTier');
  });
});
