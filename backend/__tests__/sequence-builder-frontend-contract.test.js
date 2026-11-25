import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { resetTestDb, seedTestUser, loginAs, cleanupTestDb } from './setup.js';
import { mutateDb } from '../store.js';
import { assertSequenceSaved, draftStep, fetchEnrollments, parseSequences, sequencePayload } from '../../web/src/modules/marketing/sequences/sequenceModel.ts';

let app, token;
const stamp = () => new Date().toISOString();
const tokens = Object.create(null);
const roles = ['viewer', 'member', 'admin', 'owner', 'Owner'];
const auth = (value) => ({ Authorization: `Bearer ${value}` });
const get = (path, value = token) => request(app).get(path).set(auth(value));
const post = (path, value, body) => request(app).post(path).set(auth(value)).send(body);

const payloadFor = (name, delays, options = {}) => sequencePayload(
  name,
  true,
  delays.map((delayDays, index) => draftStep({ subject: `Email ${index + 1}`, body: 'Hello {{name}}', delayDays }, `draft_${index}`)),
  options,
);

beforeAll(async () => {
  await resetTestDb();
  app = (await import('../server.js')).app;
  await seedTestUser();
  token = await loginAs(app);
  await mutateDb((db) => {
    db.contacts.push({ id: 'contact_seq', name: 'Seq Contact', email: 'seq@example.com', workspaceId: 'default', createdAt: stamp(), updatedAt: stamp() });
    for (const role of roles) {
      const key = role.toLowerCase();
      const userId = `usr_seq_${key}`;
      db.users.push({ id: userId, name: `Seq ${role}`, email: `${key}@seq.test`, role, createdAt: stamp() });
      db.sessions.push({ token: `seq-${key}-token`, userId, createdAt: stamp(), expiresAt: new Date(Date.now() + 3600000).toISOString() });
      tokens[role] = `seq-${key}-token`;
    }
  });
});
afterAll(() => cleanupTestDb());

describe('Sequence builder frontend contract against existing API', () => {
  it('creates, reloads and edits an ordered three-step cadence without replacing step ids or exit rules', async () => {
    const payload = payloadFor('Three-step outreach', [0, 2, 5], { exitRules: [{ type: 'reply', active: true }] });
    const created = await post('/api/sequences', token, payload);
    expect(created.status).toBe(201);
    const saved = assertSequenceSaved(created.body, payload);
    const rows = parseSequences((await get('/api/sequences')).body);
    expect(rows.find(row => row.id === saved.id).steps.map(row => row.delayDays)).toEqual([0, 2, 5]);

    const changed = sequencePayload(
      'Updated cadence',
      true,
      [...saved.steps].reverse().map((step, index) => draftStep(step, `edited_${index}`)),
      { exitRules: saved.exitRules },
    );
    const edited = await request(app).put(`/api/sequences/${saved.id}`).set(auth(token)).send(changed);
    expect(edited.status).toBe(200);
    assertSequenceSaved(edited.body, changed, saved.id);
    expect(edited.body.exitRules).toEqual([{ type: 'reply', active: true }]);
  });

  it('keeps cross-tenant sequences out of list, detail and enrollment reads', async () => {
    await mutateDb((db) => {
      db.sequences.push({
        id: 'seq_foreign',
        name: 'Foreign cadence',
        enabled: true,
        steps: [{ id: 'foreign_step', order: 0, action: 'sendEmail', subject: 'Foreign', body: 'Hello', delayDays: 0 }],
        exitRules: [],
        enrolled: [],
        workspaceId: 'tenant_b',
        createdAt: stamp(),
        updatedAt: stamp(),
      });
      db.contacts.push({ id: 'contact_foreign', name: 'Foreign Contact', email: 'foreign@example.com', workspaceId: 'tenant_b', createdAt: stamp(), updatedAt: stamp() });
    });

    const own = await post('/api/sequences', token, payloadFor('Own cadence', [1]));
    expect(own.status).toBe(201);
    expect((await get(`/api/sequences/${own.body.id}`)).status).toBe(200);
    expect(parseSequences((await get('/api/sequences')).body).some(row => row.id === 'seq_foreign')).toBe(false);
    expect((await get('/api/sequences/seq_foreign')).status).toBe(404);
    expect((await post('/api/sequences/seq_foreign/enroll', token, { contactIds: ['contact_foreign'] })).status).toBe(404);
    expect((await get('/api/sequences/seq_foreign/enrollments')).status).toBe(200);
    expect((await get('/api/sequences/seq_foreign/enrollments')).body.data).toEqual([]);
  });

  it('enrolls with contactIds and blocks duplicate active or paused enrollments', async () => {
    const created = await post('/api/sequences', token, payloadFor('Enrollment cadence', [0]));
    const sequenceId = created.body.id;
    const first = await post(`/api/sequences/${sequenceId}/enroll`, token, { contactIds: ['contact_seq'] });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ enrolled: 1, skipped: 0 });
    expect(first.body.enrollments[0]).toMatchObject({ sequenceId, contactId: 'contact_seq', status: 'active', currentStep: 0 });

    const duplicate = await post(`/api/sequences/${sequenceId}/enroll`, token, { contactIds: ['contact_seq'] });
    expect(duplicate.status).toBe(201);
    expect(duplicate.body).toMatchObject({ enrolled: 0, skipped: 1, enrollments: [] });

    const api = async (path) => {
      const res = await get(`/api${path}`);
      if (res.status !== 200) throw Object.assign(new Error(res.body.error), { status: res.status });
      return res.body;
    };
    const rows = await fetchEnrollments(sequenceId, api);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sequenceId, contactId: 'contact_seq', status: 'active' });
  });

  it('grants write and enroll parity to owner, Owner, admin and member while viewer stays read-only', async () => {
    const created = await post('/api/sequences', token, payloadFor('RBAC cadence', [0]));
    const sequenceId = created.body.id;
    for (const role of ['owner', 'Owner', 'admin', 'member']) {
      const write = await post('/api/sequences', tokens[role], payloadFor(`${role} cadence`, [0]));
      expect([role, write.status]).toEqual([role, 201]);
      const enroll = await post(`/api/sequences/${sequenceId}/enroll`, tokens[role], { contactIds: ['contact_seq'] });
      expect([role, enroll.status]).toEqual([role, 201]);
    }
    expect((await post('/api/sequences', tokens.viewer, payloadFor('Viewer cadence', [0]))).status).toBe(403);
    expect((await post(`/api/sequences/${sequenceId}/enroll`, tokens.viewer, { contactIds: ['contact_seq'] })).status).toBe(403);
    expect((await get(`/api/sequences/${sequenceId}`, tokens.viewer)).status).toBe(200);
  });

  it('accepts sanitized payloads and never persists prototype-pollution keys', async () => {
    const source = JSON.parse('{"subject":"Safe","body":"Message","__proto__":{"polluted":true},"nested":{"constructor":"bad","safe":"kept"}}');
    const rules = JSON.parse('[{"type":"reply","active":true,"metadata":{"prototype":"bad","safe":1}}]');
    const payload = sequencePayload('Sanitized', true, [draftStep(source, 'safe')], { exitRules: rules });
    const created = await post('/api/sequences', token, payload);
    expect(created.status).toBe(201);
    expect(Object.prototype.hasOwnProperty.call(created.body.steps[0], '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(created.body.steps[0].nested, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(created.body.exitRules[0].metadata, 'prototype')).toBe(false);
    expect(({}).polluted).toBeUndefined();
  });

  it('exposes /sequences as a viewer-visible module in the API contract', async () => {
    const modules = await get('/api/modules', tokens.viewer);
    expect(modules.status).toBe(200);
    expect(modules.body.modules).toContainEqual(expect.objectContaining({ id: 'sequences', path: '/sequences', minRole: 'viewer' }));
  });
});
