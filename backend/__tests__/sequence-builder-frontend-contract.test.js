import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { resetTestDb, seedTestUser, loginAs, cleanupTestDb } from './setup.js';
import { assertSequenceSaved, draftStep, parseSequences, sequencePayload } from '../../web/src/modules/marketing/sequences/sequenceModel.ts';
let app, token;
beforeAll(async () => { await resetTestDb(); app = (await import('../server.js')).app; await seedTestUser(); token = await loginAs(app); });
afterAll(() => cleanupTestDb());
describe('Sequence builder frontend contract against existing API', () => {
  it('creates, reloads and edits an ordered three-step cadence without replacing step ids or exit rules', async () => {
    const payload = sequencePayload('Three-step outreach', true, [0, 2, 5].map((delayDays, index) => draftStep({ subject: `Email ${index + 1}`, body: 'Hello {{name}}', delayDays }, `draft_${index}`)));
    const created = await request(app).post('/api/sequences').set('Authorization', `Bearer ${token}`).send({ ...payload, exitRules: [{ type: 'reply', active: true }] });
    expect(created.status).toBe(201);
    const saved = assertSequenceSaved(created.body, payload);
    const rows = parseSequences((await request(app).get('/api/sequences').set('Authorization', `Bearer ${token}`)).body);
    expect(rows.find(row => row.id === saved.id).steps.map(row => row.delayDays)).toEqual([0, 2, 5]);
    const changed = sequencePayload('Updated cadence', true, [...saved.steps].reverse().map((step, index) => draftStep(step, `edited_${index}`)));
    const edited = await request(app).put(`/api/sequences/${saved.id}`).set('Authorization', `Bearer ${token}`).send(changed);
    expect(edited.status).toBe(200);
    assertSequenceSaved(edited.body, changed, saved.id);
    expect(edited.body.exitRules).toEqual([{ type: 'reply', active: true }]);
  });
});
