import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import { mutateDb } from '../store.js';
import { closePool, query } from '../db/pg.js';
import { hashPassword } from '../helpers.js';
import {
  fetchInbox,
  buildEmailPayload,
  assertEmailResponse,
  normalizeDeliveryStatus,
  groupMessagesIntoThreads,
} from '../../web/src/modules/communications/inbox/inboxModel.ts';
import { broadcastTrackingUpdate } from '../routes/tracking.js';

let pgReady = false;
try {
  await query('SELECT 1 FROM activities LIMIT 1');
  pgReady = true;
} catch {
  pgReady = false;
}

const provider = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../services/smtp.js', () => ({ sendEmail: provider.send, resetTransporter: vi.fn() }));

let app, token, httpServer, port;
const workspaceId = 'ws_inbox';
const foreignWorkspaceId = 'ws_other';
const stamp = () => new Date().toISOString();
const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const root = {
  id: 'inbox_root',
  workspaceId,
  channel: 'Email',
  direction: 'Inbound',
  from: 'customer@example.com',
  to: 'test@test.com',
  subject: 'Proposal',
  body: 'Please send an update',
  read: false,
  createdAt: '2026-10-10T09:00:00Z',
};

const auth = (bearer = token) => ({ Authorization: `Bearer ${bearer}` });
const read = async (path, bearer = token) => {
  const res = await request(app).get(`/api${path}`).set(auth(bearer));
  expect(res.status).toBe(200);
  return res.body;
};

function openStream(sseToken) {
  const state = { status: undefined, events: [], buffer: '' };
  const req = http.get(
    {
      host: '127.0.0.1',
      port,
      path: `/api/events?token=${encodeURIComponent(sseToken)}`,
      headers: { Accept: 'text/event-stream' },
    },
    (res) => {
      state.status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        state.buffer += chunk;
        let idx;
        while ((idx = state.buffer.indexOf('\n\n')) !== -1) {
          const block = state.buffer.slice(0, idx);
          state.buffer = state.buffer.slice(idx + 2);
          const ev = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) ev.data = line.slice(5).trim();
          }
          if (ev.event) state.events.push(ev);
        }
      });
    },
  );
  state.close = () => req.destroy();
  return state;
}

async function waitForEvent(state, name, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = state.events.find((event) => event.event === name);
    if (found) return found;
    await delay(10);
  }
  return null;
}

beforeAll(async () => {
  await resetTestDb();
  app = (await import('../server.js')).app;
  httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  port = httpServer.address().port;
});

beforeEach(async () => {
  await resetTestDb();
  await seedTestUser();
  token = await loginAs(app);
  provider.send.mockReset();
  provider.send.mockResolvedValue({ delivered: true, status: 'Sent', providerId: 'fixture_only' });
  await mutateDb((db) => {
    const now = stamp();
    db.users.find((user) => user.id === 'usr_test').workspaceId = workspaceId;
    for (const [id, role, userWorkspaceId] of [
      ['usr_inbox_owner', 'owner', workspaceId],
      ['usr_inbox_owner_upper', 'Owner', workspaceId],
      ['usr_inbox_admin', 'admin', workspaceId],
      ['usr_inbox_member', 'member', workspaceId],
      ['usr_inbox_viewer', 'viewer', workspaceId],
      ['usr_inbox_other', 'Owner', foreignWorkspaceId],
    ]) {
      db.users.push({
        id,
        name: id,
        email: `${id}@test.com`,
        password: hashPassword('test123'),
        role,
        workspaceId: userWorkspaceId,
        createdAt: now,
      });
      db.sessions.push({
        token: `${id}-token`,
        userId: id,
        createdAt: now,
        expiresAt: inAnHour(),
      });
    }
    db.sessions.push({
      token: 'inbox-sse-token',
      userId: 'usr_test',
      purpose: 'sse',
      createdAt: now,
      expiresAt: inAnHour(),
    });
    db.sessions.push({
      token: 'inbox-sse-other-token',
      userId: 'usr_inbox_other',
      purpose: 'sse',
      createdAt: now,
      expiresAt: inAnHour(),
    });
    const foreign = { ...root, id: 'inbox_foreign', workspaceId: foreignWorkspaceId, subject: 'Foreign' };
    const rows = Array.from({ length: 54 }, (_, index) => ({
      ...root,
      id: `inbox_other_${index}`,
      subject: `Other ${index}`,
    }));
    db.messages = [root, foreign, ...rows];
  });
});

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  await closePool();
  cleanupTestDb();
});

describe('unified inbox API contract', () => {
  it('loads a complete inbox spanning multiple API pages', async () => {
    const rows = await fetchInbox(read);
    expect(rows).toHaveLength(55);
    expect(rows.some((row) => row.id === root.id)).toBe(true);
    expect(rows.some((row) => row.id === 'inbox_foreign')).toBe(false);
    expect(groupMessagesIntoThreads(rows)).toHaveLength(55);
  });

  it('preserves the paginated message and enveloped template contracts', async () => {
    const messages = await read('/messages?type=email&page=1&limit=5');
    expect(Object.keys(messages).sort()).toEqual(['data', 'limit', 'page', 'total']);
    expect(messages.total).toBe(55);
    expect(messages.data).toHaveLength(5);
    expect(messages.data.every((row) => String(row.channel).toLowerCase() === 'email')).toBe(true);

    const templates = await read('/templates');
    expect(Object.keys(templates).sort()).toEqual(['data', 'limit', 'page', 'total']);
    expect(Array.isArray(templates.data)).toBe(true);

    if (pgReady) {
      const openedAt = stamp();
      await query(
        `INSERT INTO activities (workspace_id, type, title, metadata, created_at)
         VALUES ($1, 'email_open', 'Email opened', $2, $3),
                ($1, 'email_click', 'Email link clicked', $4, $3),
                ($5, 'email_open', 'Email opened', $6, $3)`,
        [
          workspaceId,
          JSON.stringify({ messageId: root.id, openedAt }),
          openedAt,
          JSON.stringify({ messageId: root.id, clickedAt: openedAt }),
          foreignWorkspaceId,
          JSON.stringify({ messageId: root.id, openedAt }),
        ],
      );
      const rows = await fetchInbox(read);
      const tracked = rows.find((item) => item.id === root.id);
      expect(tracked.openCount).toBe(1);
      expect(tracked.clickCount).toBe(1);
      expect(tracked.openedAt).toBe(openedAt);
      expect(tracked.clickedAt).toBe(openedAt);
      const untracked = rows.find((item) => item.id !== root.id);
      expect(untracked.openCount).toBe(0);
      expect(untracked.clickCount).toBe(0);
      expect(untracked.openedAt).toBe('');
      expect(untracked.clickedAt).toBe('');
    }
  });

  it('sends an inline reply once and groups it with the original conversation', async () => {
    await mutateDb((db) => {
      db.settings = { smtpHost: 'example.invalid', smtpUser: 'fixture', smtpPass: 'not-a-real-password' };
    });
    const payload = {
      ...buildEmailPayload('customer@example.com', 'Re: Proposal', 'Here is the update', 'reply_fixture'),
      idempotencyKey: 'reply_fixture',
    };
    const first = await request(app).post('/api/messages/send').set(auth()).send(payload);
    expect(first.status).toBe(200);
    const row = assertEmailResponse(first.body, payload);
    expect(row.id).toBeTruthy();
    expect(normalizeDeliveryStatus(row.status)).toBe('Sent');

    const replay = await request(app).post('/api/messages/send').set(auth()).send(payload);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(row.id);
    expect(provider.send).toHaveBeenCalledTimes(1);

    const thread = groupMessagesIntoThreads(await fetchInbox(read)).find((group) =>
      (group.messages || []).some((message) => message.id === root.id),
    );
    expect(thread).toBeTruthy();
    expect(thread.messages.map((message) => message.id)).toEqual(expect.arrayContaining([root.id, row.id]));
  });

  it('distinguishes saved mail from actual delivery when SMTP is unavailable', async () => {
    const payload = {
      ...buildEmailPayload('customer@example.com', 'Re: Proposal', 'Stored update', 'saved_fixture'),
      idempotencyKey: 'saved_fixture',
    };
    const result = await request(app).post('/api/messages/send').set(auth()).send(payload);
    expect(result.status).toBe(200);
    const row = assertEmailResponse(result.body, payload);
    expect(row.status).toBe('Saved');
    expect(normalizeDeliveryStatus(row.status)).toBe('Saved');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('persists acknowledged read state', async () => {
    const marked = await request(app).patch(`/api/messages/${root.id}`).set(auth()).send({ read: true });
    expect(marked.status).toBe(200);
    expect(marked.body.read).toBe(true);
    const rows = await fetchInbox(read);
    expect(rows.find((row) => row.id === root.id).read).toBe(true);
  });

  it('allows viewer reads while rejecting send, patch and delete', async () => {
    const viewer = 'usr_inbox_viewer-token';
    expect(await fetchInbox((path) => read(path, viewer))).toHaveLength(55);
    expect((await request(app).post('/api/messages/send').set(auth(viewer)).send(buildEmailPayload('customer@example.com', 'Proposal', 'Hi', 'denied'))).status).toBe(403);
    expect((await request(app).patch(`/api/messages/${root.id}`).set(auth(viewer)).send({ read: true })).status).toBe(403);
    expect((await request(app).delete(`/api/messages/${root.id}`).set(auth(viewer))).status).toBe(403);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('grants owner, Owner, admin and member the same inbox write access', async () => {
    for (const bearer of ['usr_inbox_owner-token', 'usr_inbox_owner_upper-token', 'usr_inbox_admin-token', 'usr_inbox_member-token']) {
      const payload = {
        ...buildEmailPayload('customer@example.com', 'Role parity', 'Hello', bearer),
        idempotencyKey: bearer,
      };
      const res = await request(app).post('/api/messages/send').set(auth(bearer)).send(payload);
      expect(res.status, bearer).toBe(200);
      const marked = await request(app).patch(`/api/messages/${root.id}`).set(auth(bearer)).send({ read: true });
      expect(marked.status, bearer).toBe(200);
    }
  });

  it('hides foreign tenant messages from lists, details, patches and deletes', async () => {
    const foreign = 'usr_inbox_other-token';
    expect((await fetchInbox((path) => read(path, foreign))).some((row) => row.id === root.id)).toBe(false);
    expect((await read('/messages', foreign)).data.some((row) => row.id === root.id)).toBe(false);
    expect((await request(app).get(`/api/messages/${root.id}`).set(auth(foreign))).status).toBe(404);
    expect((await request(app).patch(`/api/messages/${root.id}`).set(auth(foreign)).send({ read: true })).status).toBe(404);
    expect((await request(app).delete(`/api/messages/${root.id}`).set(auth(foreign))).status).toBe(404);
    expect((await request(app).get('/api/messages/inbox_foreign').set(auth())).status).toBe(404);
  });

  it('does not let cross-tenant idempotency keys or ids collide', async () => {
    const foreign = 'usr_inbox_other-token';
    const payload = {
      ...buildEmailPayload('customer@example.com', 'Shared key', 'Hello', 'shared_key'),
      idempotencyKey: 'shared_key',
    };
    const first = await request(app).post('/api/messages/send').set(auth()).send(payload);
    expect(first.status).toBe(200);
    const replay = await request(app).post('/api/messages/send').set(auth(foreign)).send(payload);
    expect(replay.status).toBe(200);
    expect(replay.body.id).not.toBe(first.body.id);

    const overwrite = await request(app).post('/api/messages/send').set(auth(foreign)).send({ ...payload, id: first.body.id });
    expect(overwrite.status).toBe(200);
    expect(overwrite.body.id).not.toBe(first.body.id);

    const original = await request(app).get(`/api/messages/${first.body.id}`).set(auth());
    expect(original.status).toBe(200);
    expect(original.body.subject).toBe(payload.subject || 'Shared key');
  });

  it('streams scoped record.created, record.updated and record.deleted events', async () => {
    const own = openStream('inbox-sse-token');
    const other = openStream('inbox-sse-other-token');
    try {
      expect(await waitForEvent(own, 'connected')).not.toBeNull();
      expect(await waitForEvent(other, 'connected')).not.toBeNull();

      const payload = {
        ...buildEmailPayload('customer@example.com', 'SSE reply', 'Hello', 'sse_fixture'),
        idempotencyKey: 'sse_fixture',
      };
      const sent = await request(app).post('/api/messages/send').set(auth()).send(payload);
      expect(sent.status).toBe(200);
      const created = await waitForEvent(own, 'record.created');
      expect(created).not.toBeNull();
      expect(JSON.parse(created.data).resource).toBe('messages');
      await delay(150);
      expect(other.events.some((event) => event.event === 'record.created')).toBe(false);

      const marked = await request(app).patch(`/api/messages/${root.id}`).set(auth()).send({ read: true });
      expect(marked.status).toBe(200);
      expect(await waitForEvent(own, 'record.updated')).not.toBeNull();

      own.events.length = 0;
      other.events.length = 0;
      expect(broadcastTrackingUpdate({ workspaceId, messageId: root.id })).toBe(1);
      const tracked = await waitForEvent(own, 'record.updated');
      expect(tracked).not.toBeNull();
      expect(JSON.parse(tracked.data)).toEqual({ resource: 'messages', id: root.id });
      await delay(150);
      expect(other.events.some((event) => event.event === 'record.updated')).toBe(false);

      const removed = await request(app).delete(`/api/messages/${root.id}`).set(auth());
      expect(removed.status).toBe(200);
      expect(await waitForEvent(own, 'record.deleted')).not.toBeNull();
    } finally {
      own.close();
      other.close();
    }
  });

  it('requires authentication for inbox reads', async () => {
    expect((await request(app).get('/api/messages?type=email')).status).toBe(401);
  });
});
