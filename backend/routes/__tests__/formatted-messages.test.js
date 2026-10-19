import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import registerMessageRoutes from '../messages.js';
const state = vi.hoisted(() => ({ db: { messages: [], activities: [], audit: [] }, smtp: vi.fn(), settings: { emailTracking: false, publicBaseUrl: '' } }));
vi.mock('../../store.js', () => ({ mutateDb: async fn => fn(state.db) }));
vi.mock('../../middleware/auth.js', () => ({ auth: (req, _res, next) => { req.user = { name: 'Fixture', role: req.headers['x-test-role'] || 'member' }; next(); } }));
vi.mock('../../services/config.js', () => ({ getSettings: async () => state.settings, isEmailConfigured: () => true, isTwilioConfigured: () => false }));
vi.mock('../../services/smtp.js', () => ({ sendEmail: state.smtp }));
vi.mock('../../services/twilio.js', () => ({ sendSms: vi.fn() }));
vi.mock('../../services/workflows.js', () => ({ triggerWorkflows: vi.fn() }));
vi.mock('../../services/rateLimit.js', () => ({ createRateLimiter: () => (_req, _res, next) => next() }));
const app = express(); app.use(express.json()); registerMessageRoutes(app);
const payload = { channel: 'Email', to: 'customer@example.com', subject: 'Hello', body: 'Bold link', html: '<b>Bold</b> <a href="https://example.com/">link</a>', idempotencyKey: 'fixture-key' };
beforeEach(() => { state.db.messages = []; state.db.activities = []; state.db.audit = []; state.settings.emailTracking = false; state.settings.publicBaseUrl = ''; state.smtp.mockReset().mockResolvedValue({ delivered: true, status: 'Sent' }); });
describe('formatted email route compatibility', () => {
  it('sends sanitized formatting with a separate plain-text fallback', async () => {
    const result = await request(app).post('/api/messages/send').send(payload); expect(result.status).toBe(200); expect(result.body.status).toBe('Sent');
    expect(state.smtp).toHaveBeenCalledWith(state.settings, expect.objectContaining({ text: payload.body, html: payload.html }));
    expect(result.body.html).toBe(payload.html);
  });
  it('keeps old plain-text clients compatible', async () => {
    const plain = { ...payload }; delete plain.html;
    const result = await request(app).post('/api/messages/send').send(plain); expect(result.status).toBe(200);
    expect(state.smtp.mock.calls[0][1].text).toBe(payload.body); expect(state.smtp.mock.calls[0][1].html).toBeUndefined();
  });
  it('does not send twice for a repeated accepted idempotency key', async () => {
    const first = await request(app).post('/api/messages/send').send(payload), second = await request(app).post('/api/messages/send').send(payload);
    expect(second.body.id).toBe(first.body.id); expect(state.smtp).toHaveBeenCalledTimes(1); expect(state.db.messages).toHaveLength(1);
  });
  it('strips unapproved HTML before it reaches the provider or stored message', async () => {
    const result = await request(app).post('/api/messages/send').send({ ...payload, html: '<img src=x onerror=bad><strong>Hello</strong>' });
    expect(result.body.html).toBe('<strong>Hello</strong>'); expect(state.smtp.mock.calls[0][1].html).toBe('<strong>Hello</strong>');
  });
  it('preserves the open-tracking pixel without rewriting formatted link markup', async () => {
    state.settings.emailTracking = true; state.settings.publicBaseUrl = 'https://crm.example';
    await request(app).post('/api/messages/send').send(payload);
    expect(state.smtp.mock.calls[0][1].html).toContain('/api/tracking/open/'); expect(state.smtp.mock.calls[0][1].html).toContain(payload.html);
  });
  it('rejects oversized formatting before creating a message', async () => { expect((await request(app).post('/api/messages/send').send({ ...payload, html: 'x'.repeat(100001) })).status).toBe(400); expect(state.db.messages).toHaveLength(0); });
  it('preserves viewer write restrictions', async () => { expect((await request(app).post('/api/messages/send').set('x-test-role', 'viewer').send(payload)).status).toBe(403); expect(state.smtp).not.toHaveBeenCalled(); });
  it('retains Saved and Failed outcomes instead of reporting delivery', async () => {
    state.smtp.mockResolvedValueOnce({ delivered: false, status: 'Saved' }).mockResolvedValueOnce({ delivered: false, status: 'Failed', error: 'Fixture failure' });
    const saved = await request(app).post('/api/messages/send').send(payload), failed = await request(app).post('/api/messages/send').send({ ...payload, idempotencyKey: 'other-key' });
    expect(saved.body.status).toBe('Saved'); expect(saved.body.deliveredAt).toBe(''); expect(failed.body.status).toBe('Failed'); expect(failed.body.deliveredAt).toBe('');
  });
  it('clears stale HTML when retrying a failed message as plain text', async () => {
    state.smtp.mockResolvedValueOnce({ delivered: false, status: 'Failed' }).mockResolvedValueOnce({ delivered: true, status: 'Sent' });
    const first = await request(app).post('/api/messages/send').send(payload);
    const plain = { ...payload }; delete plain.html;
    const retry = await request(app).post('/api/messages/send').send(plain);
    expect(retry.body.id).toBe(first.body.id); expect(retry.body.html).toBeUndefined(); expect(state.smtp.mock.calls[1][1].html).toBeUndefined();
  });
});
