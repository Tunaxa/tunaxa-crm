import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { closePool } from '../db/pg.js';
import { resetTestDb, seedTestUser, loginAs } from './setup.js';
import { mutateDb } from '../store.js';
import { RECOGNIZED_STAGES } from '../services/ticket-stages.js';
import { DEFAULT_SLA_TARGETS } from '../services/sla.js';


let app;
let adminToken;
let tenantBToken;
let viewerToken;

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

const REQUIRED_FIELD_ATTRS = ['name', 'key', 'label', 'type', 'required', 'readOnly'];

const as = (token) => ({ Authorization: `Bearer ${token}` });

const getSchema = (token, resource) =>
  request(app).get(`/api/schema/${resource}`).set(as(token));

const byName = (fields = []) =>
  Object.fromEntries(fields.map((field) => [field.name, field]));

async function createUser({ email, role, workspaceId }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('test123', salt, 64).toString('hex');
  const password = `${salt}:${hash}`;
  await mutateDb((db) => {
    db.users.push({
      id: `usr_${crypto.randomUUID()}`,
      name: email,
      email,
      password,
      role,
      workspaceId,
      createdAt: new Date().toISOString(),
    });
  });
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'test123' });
  if (response.status !== 200) {
    throw new Error(`login failed for ${email}: ${response.status}`);
  }
  return response.body.token;
}

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  adminToken = await loginAs(app); 

  tenantBToken = await createUser({
    email: 'tenantb-schema@test.com',
    role: 'Owner',
    workspaceId: 'tenant-b',
  });

  viewerToken = await createUser({
    email: 'viewer-schema@test.com',
    role: 'viewer',
    workspaceId: 'default',
  });
}, 30000);

afterAll(async () => {
  try {
    await closePool();
  } catch { void 0; }
});

describe('GET /api/schema/:resource auth and routing', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/schema/tickets');
    expect(res.status).toBe(401);
  });

  it('returns 404 with a helpful message for an unknown resource', async () => {
    const res = await getSchema(adminToken, 'nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown resource/i);
    expect(res.body.error).toContain('tickets');
  });

  it('returns 404 for prototype-key resource names', async () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const res = await getSchema(adminToken, key);
      expect(res.status).toBe(404);
    }
  });
});

describe('schema contract', () => {
  it('describes every supported resource with the minimum field contract', async () => {
    for (const resource of RESOURCES) {
      const res = await getSchema(adminToken, resource);
      expect(res.status).toBe(200);
      expect(res.body.object).toBe(resource);
      expect(res.body.resource).toBe(resource);
      expect(res.body.primaryKey).toBe('id');
      expect(typeof res.body.label).toBe('string');
      expect(Array.isArray(res.body.fields)).toBe(true);
      expect(res.body.fields.length).toBeGreaterThan(0);
      expect(Array.isArray(res.body.customFields)).toBe(true);

      for (const field of res.body.fields) {
        for (const attr of REQUIRED_FIELD_ATTRS) {
          expect(field, `${resource}.${field.name} missing ${attr}`).toHaveProperty(attr);
        }
        expect(typeof field.name).toBe('string');
        expect(field.name.length).toBeGreaterThan(0);
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
      const res = await getSchema(adminToken, resource);
      const fields = byName(res.body.fields);
      expect(fields.id.readOnly).toBe(true);
      expect(fields.createdAt.readOnly).toBe(true);
      expect(fields.updatedAt.readOnly).toBe(true);
    }
  });
});

describe('contact schema', () => {
  it('exposes the core fields with labels and types', async () => {
    const res = await getSchema(adminToken, 'contacts');
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
      .set(as(adminToken))
      .send({ firstName: 'Grace', lastName: 'Hopper', email: 'grace-schema@example.com' });
    expect(created.status).toBe(201);
    expect(created.body.first_name || created.body.firstName).toBe('Grace');
    expect(created.body.last_name || created.body.lastName).toBe('Hopper');
    expect(created.body.name).toBe('Grace Hopper');
  });
});

describe('ticket schema alignment with #465', () => {
  it('offers ticket stages and SLA priority levels as select options', async () => {
    const res = await getSchema(adminToken, 'tickets');
    expect(res.status).toBe(200);
    const fields = byName(res.body.fields);

    expect(fields.stage.type).toBe('select');
    expect(fields.stage.options.map((o) => o.value)).toEqual(
      expect.arrayContaining(RECOGNIZED_STAGES),
    );

    const priorityValues = fields.priority.options.map((o) => o.value);
    const expectedPriorities = Object.keys(DEFAULT_SLA_TARGETS).map(
      (k) => k.charAt(0).toUpperCase() + k.slice(1),
    );
    for (const value of expectedPriorities) {
      expect(priorityValues).toContain(value);
    }
    for (const option of fields.stage.options) {
      expect(option).toHaveProperty('label');
      expect(option).toHaveProperty('value');
    }
  });

  it('marks subject required and SLA/history fields read-only', async () => {
    const res = await getSchema(adminToken, 'tickets');
    const fields = byName(res.body.fields);
    expect(fields.subject.required).toBe(true);
    for (const key of [
      'comments',
      'firstResponseAt',
      'firstResponseDueAt',
      'resolvedAt',
      'resolvedBy',
      'slaDueAt',
      'slaBreached',
      'closedAt',
      'stageHistory',
    ]) {
      expect(fields[key], `${key} should exist`).toBeDefined();
      expect(fields[key].readOnly, `${key} should be read-only`).toBe(true);
    }
  });
});

describe('deal schema', () => {
  it('returns stage options, workspace currency and the value field', async () => {
    const res = await getSchema(adminToken, 'deals');
    expect(res.status).toBe(200);
    expect(typeof res.body.currency).toBe('string');
    expect(res.body.currency.length).toBeGreaterThan(0);

    const fields = byName(res.body.fields);
    expect(fields.value).toMatchObject({ type: 'number', format: 'currency' });
    expect(fields.stage.type).toBe('select');
    expect(fields.stage.options.length).toBeGreaterThan(0);
    expect(fields.title.required).toBe(true);
  });

  it('reflects tenant-scoped pipeline definitions and isolates them across tenants', async () => {
    const create = await request(app)
      .post('/api/pipeline-definitions')
      .set(as(adminToken))
      .send({
        name: `Reflection Pipeline ${Date.now()}`,
        entityType: 'deal',
        stages: [
          { key: 'discovery', label: 'Discovery', probability: 20, order: 0 },
          { key: 'qualified_ref', label: 'Qualified', probability: 40, order: 1 },
          { key: 'closed_won_ref', label: 'Won', probability: 100, order: 2 },
        ],
      });
    expect(create.status).toBe(201);

    const resA = await getSchema(adminToken, 'deals');
    expect(resA.status).toBe(200);
    const fieldsA = byName(resA.body.fields);
    const stageValuesA = (fieldsA.stage.options || []).map((o) => o.value);
    expect(stageValuesA).toContain('discovery');
    expect(stageValuesA).toContain('closed_won_ref');
    const pipelineValuesA = (fieldsA.pipelineId.options || []).map((o) => o.value);
    expect(pipelineValuesA).toContain(create.body.id);

    const resB = await getSchema(tenantBToken, 'deals');
    expect(resB.status).toBe(200);
    const fieldsB = byName(resB.body.fields);
    const pipelineValuesB = (fieldsB.pipelineId.options || []).map((o) => o.value);
    expect(pipelineValuesB).not.toContain(create.body.id);

    const stageValuesB = (fieldsB.stage.options || []).map((o) => o.value);
    expect(stageValuesB).not.toContain('discovery');
    expect(stageValuesB.length).toBeGreaterThan(0);
  });
});

describe('custom fields', () => {
  it('merges per-object custom fields into the reflection payload', async () => {
    const create = await request(app)
      .post('/api/customFields')
      .set(as(adminToken))
      .send({
        object: 'Contact',
        key: `loyaltyTier_${Date.now()}`,
        name: 'Loyalty Tier',
        type: 'Dropdown',
        options: 'Gold, Silver, Bronze',
      });
    expect([200, 201]).toContain(create.status);
    const key = create.body?.key || create.body?.id ? (create.body.key) : null;
    const res = await getSchema(adminToken, 'contacts');
    expect(res.status).toBe(200);
    const field = res.body.fields.find(
      (item) => item.name === 'Loyalty Tier'.replace(/\s+/g, '') || item.label === 'Loyalty Tier' || item.name === key || item.key === key,
    ) || res.body.customFields.find((item) => item.label === 'Loyalty Tier' || item.key === key);

    if (field) {
      expect(field.label).toBe('Loyalty Tier');
      if (field.custom !== undefined) expect(field.custom).toBe(true);
      expect(field.type).toBe('select');
      const values = (field.options || []).map((o) => o.value);
      expect(values).toEqual(expect.arrayContaining(['Gold', 'Silver', 'Bronze']));
    } else {
      expect(res.body.customFields.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('does not leak tenant-scoped custom fields across tenants', async () => {
    const fieldKey = `tenantSecret_${Date.now()}`;
    await mutateDb((db) => {
      if (!Array.isArray(db.customFields)) db.customFields = [];
      db.customFields.push({
        id: `cf_${crypto.randomUUID()}`,
        object: 'Contact',
        key: fieldKey,
        name: 'Tenant Secret Field',
        type: 'Text',
        workspaceId: 'tenant-b',
        createdAt: new Date().toISOString(),
      });
    });

    const resB = await getSchema(tenantBToken, 'contacts');
    expect(resB.status).toBe(200);
    expect((resB.body.fields || []).some((f) => f.name === fieldKey)).toBe(true);
    expect((resB.body.customFields || []).some((f) => f.key === fieldKey)).toBe(true);

    const resA = await getSchema(adminToken, 'contacts');
    expect(resA.status).toBe(200);
    expect((resA.body.fields || []).some((f) => f.name === fieldKey)).toBe(false);
    expect((resA.body.customFields || []).some((f) => f.key === fieldKey)).toBe(false);
  });
});

describe('field-mask / RBAC enforcement', () => {
  it('omits masked fields from reflected schema fields for restricted roles', async () => {
    const save = await request(app)
      .put('/api/permissions/fields/contact')
      .set(as(adminToken))
      .send({ role: 'viewer', visible: null, hidden: ['phone', 'email'] });
    expect(save.status).toBe(200);

    const res = await getSchema(viewerToken, 'contacts');
    expect(res.status).toBe(200);
    const names = (res.body.fields || []).map((f) => f.name);
    expect(names).not.toContain('phone');
    expect(names).not.toContain('email');
    expect(names).toContain('firstName');
  });

  it('omits masked custom fields for restricted roles', async () => {
    const key = `maskedCustom_${Date.now()}`;
    await mutateDb((db) => {
      if (!Array.isArray(db.customFields)) db.customFields = [];
      db.customFields.push({
        id: `cf_${crypto.randomUUID()}`,
        object: 'Lead',
        key,
        name: 'Masked Custom',
        type: 'Text',
        createdAt: new Date().toISOString(),
      });
      db.fieldPermissions = db.fieldPermissions || {};
      db.fieldPermissions.lead = db.fieldPermissions.lead || {};
      db.fieldPermissions.lead.viewer = { visible: null, hidden: [key] };
    });

    const res = await getSchema(viewerToken, 'leads');
    expect(res.status).toBe(200);
    expect((res.body.fields || []).some((f) => f.name === key)).toBe(false);
    expect((res.body.customFields || []).some((f) => f.key === key)).toBe(false);

    const resAdmin = await getSchema(adminToken, 'leads');
    expect(resAdmin.status).toBe(200);
    expect((resAdmin.body.customFields || []).some((f) => f.key === key)).toBe(true);
  });
});
