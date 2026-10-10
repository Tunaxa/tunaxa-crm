import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import { mutateDb } from '../store.js';
import { fetchInbox, buildThreads, emailPayload, assertEmailResponse, deliveryLabel } from '../../web/src/modules/communications/inbox/inboxModel.ts';
const provider = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../services/smtp.js', () => ({ sendEmail: provider.send, resetTransporter: vi.fn() }));
let app, token;
const root = { id: 'inbound_fixture', channel: 'Email', direction: 'Inbound', from: 'customer@example.com', to: 'test@test.com', subject: 'Proposal', body: 'Please send an update', read: false, createdAt: '2026-10-10T09:00:00Z' };
const auth = () => ({ Authorization: `Bearer ${token}` });
const read = path => request(app).get(`/api${path}`).set(auth()).then(result => { expect(result.status).toBe(200); return result.body; });
beforeAll(async () => { await resetTestDb(); app = (await import('../server.js')).app; });
beforeEach(async () => {
  await resetTestDb(); await seedTestUser(); token = await loginAs(app);
  provider.send.mockReset(); provider.send.mockResolvedValue({ delivered: true, status: 'Sent', providerId: 'fixture_only' });
  await mutateDb(db => { db.messages = [root, ...Array.from({ length: 54 }, (_, index) => ({ ...root, id: `other_${index}`, subject: `Other ${index}` }))]; });
});
afterAll(() => cleanupTestDb());
describe('unified inbox API contract', () => {
  it('loads a complete inbox spanning multiple API pages', async () => { const rows = await fetchInbox(read); expect(rows).toHaveLength(55); expect(buildThreads(rows)).toHaveLength(55); });
  it('sends an inline reply once and groups it with the original conversation', async () => {
    await mutateDb(db => { db.settings = { smtpHost: 'example.invalid', smtpUser: 'fixture', smtpPass: 'not-a-real-password' }; });
    const payload = emailPayload('customer@example.com', 'Re: Proposal', 'Here is the update', 'reply_fixture');
    const first = await request(app).post('/api/messages/send').set(auth()).send(payload); expect(first.status).toBe(200);
    const row = assertEmailResponse(first.body, payload); expect(deliveryLabel(row)).toBe('Email sent');
    const replay = await request(app).post('/api/messages/send').set(auth()).send(payload); expect(replay.status).toBe(200); expect(replay.body.id).toBe(row.id);
    expect(provider.send).toHaveBeenCalledTimes(1);
    const thread = buildThreads(await fetchInbox(read)).find(group => group.subject === 'Proposal'); expect(thread.messages.map(message => message.id)).toEqual([root.id, row.id]);
  });
  it('persists acknowledged read state', async () => {
    const marked = await request(app).patch(`/api/messages/${root.id}`).set(auth()).send({ read: true }); expect(marked.status).toBe(200); expect(marked.body.read).toBe(true);
    expect((await fetchInbox(read)).find(row => row.id === root.id).read).toBe(true);
  });
  it('distinguishes saved mail from actual delivery when SMTP is unavailable', async () => {
    const payload = emailPayload('customer@example.com', 'Re: Proposal', 'Stored update', 'saved_fixture');
    const result = await request(app).post('/api/messages/send').set(auth()).send(payload); expect(result.status).toBe(200);
    const row = assertEmailResponse(result.body, payload); expect(row.status).toBe('Saved'); expect(deliveryLabel(row)).not.toBe('Email sent'); expect(provider.send).not.toHaveBeenCalled();
  });
  it('allows viewer reads while rejecting send and delete actions', async () => {
    await mutateDb(db => { db.users.find(user => user.id === 'usr_test').role = 'viewer'; });
    expect(await fetchInbox(read)).toHaveLength(55);
    expect((await request(app).post('/api/messages/send').set(auth()).send(emailPayload('customer@example.com', 'Proposal', 'Hi', 'denied'))).status).toBe(403);
    expect((await request(app).delete(`/api/messages/${root.id}`).set(auth())).status).toBe(403);
    expect(provider.send).not.toHaveBeenCalled();
  });
  it('requires authentication for inbox reads', async () => expect((await request(app).get('/api/messages?type=email')).status).toBe(401));
});
