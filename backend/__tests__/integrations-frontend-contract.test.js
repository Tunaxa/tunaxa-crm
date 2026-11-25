import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb } from './setup.js';
import { mutateDb, readDb } from '../store.js';

process.env.RATE_LIMIT_GLOBAL_MAX = '10000';

const urlA = 'https://hooks.slack.com/services/T000/B000/aaaaaa111111';
const urlB = 'https://hooks.slack.com/services/T111/B111/bbbbbb222222';
const maskA = 'https://hooks.slack.com/••••••111111';
const maskB = 'https://hooks.slack.com/••••••222222';

const seeded = [
  { id: 'usr_int_admin_a', token: 'int-admin-a', role: 'admin', workspaceId: 'ws-a' },
  { id: 'usr_int_owner_a', token: 'int-owner-a', role: 'Owner', workspaceId: 'ws-a' },
  { id: 'usr_int_member_a', token: 'int-member-a', role: 'member', workspaceId: 'ws-a' },
  { id: 'usr_int_viewer_a', token: 'int-viewer-a', role: 'viewer', workspaceId: 'ws-a' },
  { id: 'usr_int_admin_b', token: 'int-admin-b', role: 'admin', workspaceId: 'ws-b' },
];

const tokenFor = (id) => seeded.find((user) => user.id === id).token;
let app;

function call(method, path, token) {
  const req = request(app)[method](path);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
}

const emptyStatus = {
  slack: { configured: false, webhookUrlMasked: '' },
  zapier: { configured: false, webhookUrlMasked: '' },
};

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await mutateDb((db) => {
    for (const user of seeded) {
      db.users.push({
        id: user.id,
        name: user.id,
        email: `${user.id}@test.com`,
        role: user.role,
        workspaceId: user.workspaceId,
        createdAt: new Date().toISOString(),
      });
      db.sessions.push({
        token: user.token,
        userId: user.id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
    }
  });
}, 30000);

afterAll(() => cleanupTestDb());

describe('GET /api/integrations', () => {
  it('requires authentication', async () => {
    const res = await call('get', '/api/integrations');
    expect(res.status).toBe(401);
  });

  it('returns a write-only masked catalog for read-only roles', async () => {
    const res = await call('get', '/api/integrations', tokenFor('usr_int_member_a'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(emptyStatus);
    expect(Object.keys(res.body.slack).sort()).toEqual(['configured', 'webhookUrlMasked']);
    expect(JSON.stringify(res.body)).not.toContain('"webhookUrl"');
  });
});

describe('PUT /api/integrations/slack', () => {
  it('rejects non-admin roles', async () => {
    for (const id of ['usr_int_member_a', 'usr_int_viewer_a']) {
      const res = await call('put', '/api/integrations/slack', tokenFor(id)).send({
        slackWebhookUrl: urlA,
      });
      expect(res.status).toBe(403);
    }
  });

  it.each([
    ['http', urlA.replace('https:', 'http:')],
    ['javascript', 'javascript:alert(1)'],
    ['suffix host', urlA.replace('hooks.slack.com', 'hooks.slack.com.evil.test')],
    ['other host', urlA.replace('hooks.slack.com', 'example.com')],
    ['userinfo', urlA.replace('https://', 'https://user:password@')],
    ['port', urlA.replace('hooks.slack.com', 'hooks.slack.com:444')],
    ['query', `${urlA}?token=secret`],
    ['hash', `${urlA}#secret`],
    ['internal ip', urlA.replace('hooks.slack.com', '127.0.0.1')],
    ['ipv6 loopback', urlA.replace('hooks.slack.com', '[::1]')],
    ['bad path', 'https://hooks.slack.com/services/only-one'],
  ])('rejects a %s webhook URL', async (_label, value) => {
    const res = await call('put', '/api/integrations/slack', tokenFor('usr_int_admin_a')).send({
      slackWebhookUrl: value,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).not.toContain('secret');
    expect(res.body.error).not.toContain('password');
  });

  it.each([
    ['__proto__', '{"slackWebhookUrl":"' + urlA + '","__proto__":{"polluted":true}}'],
    ['constructor', '{"slackWebhookUrl":"' + urlA + '","constructor":"polluted"}'],
    ['prototype', '{"slackWebhookUrl":"' + urlA + '","prototype":{"polluted":true}}'],
    [
      'nested __proto__',
      '{"slackWebhookUrl":"' + urlA + '","meta":{"__proto__":{"polluted":true}}}',
    ],
  ])('rejects the unsafe key %s', async (_label, body) => {
    const res = await call('put', '/api/integrations/slack', tokenFor('usr_int_admin_a'))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    expect(Object.prototype.polluted).toBeUndefined();
    expect({}.polluted).toBeUndefined();
  });

  it('saves a masked acknowledgement for admins and owners and isolates tenants', async () => {
    const admin = tokenFor('usr_int_admin_a');
    const saved = await call('put', '/api/integrations/slack', admin).send({
      slackWebhookUrl: urlA,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.slack).toEqual({ configured: true, webhookUrlMasked: maskA });
    expect(JSON.stringify(saved.body)).not.toContain(urlA);

    const read = await call('get', '/api/integrations', admin);
    expect(read.body.slack.webhookUrlMasked).toBe(maskA);

    const other = tokenFor('usr_int_admin_b');
    expect((await call('get', '/api/integrations', other)).body).toEqual(emptyStatus);

    const otherSave = await call('put', '/api/integrations/slack', other).send({
      slackWebhookUrl: urlB,
    });
    expect(otherSave.status).toBe(200);
    expect(otherSave.body.slack.webhookUrlMasked).toBe(maskB);
    expect((await call('get', '/api/integrations', admin)).body.slack.webhookUrlMasked).toBe(maskA);

    const ownerSave = await call('put', '/api/integrations/slack', tokenFor('usr_int_owner_a')).send({
      slackWebhookUrl: urlA,
    });
    expect(ownerSave.status).toBe(200);

    const db = await readDb();
    expect(db.integrations['ws_ws-a'].slack.webhookUrl).toBe(urlA);
    expect(db.integrations['ws_ws-b'].slack.webhookUrl).toBe(urlB);
    expect(db.audit.some((entry) => entry.action === 'Slack integration configured')).toBe(true);
  });
});

describe('DELETE /api/integrations/slack', () => {
  it('rejects non-admin roles', async () => {
    const res = await call('delete', '/api/integrations/slack', tokenFor('usr_int_member_a'));
    expect(res.status).toBe(403);
  });

  it('disconnects only the caller’s workspace', async () => {
    const removed = await call('delete', '/api/integrations/slack', tokenFor('usr_int_admin_a'));
    expect(removed.status).toBe(200);
    expect(removed.body.slack).toEqual({ configured: false, webhookUrlMasked: '' });
    expect((await call('get', '/api/integrations', tokenFor('usr_int_admin_a'))).body).toEqual(emptyStatus);
    expect((await call('get', '/api/integrations', tokenFor('usr_int_admin_b'))).body.slack.webhookUrlMasked).toBe(maskB);

    const db = await readDb();
    expect(db.integrations['ws_ws-a'].slack.webhookUrl).toBeUndefined();
    expect(db.audit.some((entry) => entry.action === 'Slack integration disconnected')).toBe(true);
  });
});

describe('POST /api/integrations/slack/test', () => {
  it('rejects non-admin roles and an unconfigured workspace', async () => {
    const forbidden = await call('post', '/api/integrations/slack/test', tokenFor('usr_int_viewer_a'));
    expect(forbidden.status).toBe(403);
    const missing = await call('post', '/api/integrations/slack/test', tokenFor('usr_int_admin_a'));
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('not configured');
  });

  it('reports a safe result without returning the webhook URL', async () => {
    await call('put', '/api/integrations/slack', tokenFor('usr_int_admin_a')).send({
      slackWebhookUrl: urlA,
    });
    const originalFetch = globalThis.fetch;
    try {
      const successFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      globalThis.fetch = successFetch;
      const success = await call('post', '/api/integrations/slack/test', tokenFor('usr_int_admin_a'));
      expect(success.status).toBe(200);
      expect(success.body).toMatchObject({ success: true, configured: true, provider: 'slack' });
      expect(JSON.stringify(success.body)).not.toContain(urlA);
      expect(successFetch).toHaveBeenCalledWith(
        urlA,
        expect.objectContaining({ method: 'POST', redirect: 'manual' }),
      );

      globalThis.fetch = vi.fn().mockRejectedValue(new Error(`failed for ${urlA}`));
      const failed = await call('post', '/api/integrations/slack/test', tokenFor('usr_int_admin_a'));
      expect(failed.status).toBe(502);
      expect(failed.body.error).not.toContain(urlA);
      expect(failed.body.error).toBe('Slack webhook did not respond successfully.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('revalidates a stored webhook before probing it', async () => {
    await call('put', '/api/integrations/slack', tokenFor('usr_int_admin_a')).send({
      slackWebhookUrl: urlA,
    });
    await mutateDb((db) => {
      db.integrations['ws_ws-a'].slack.webhookUrl = 'https://internal.test/services/T/B/secret123';
    });
    const res = await call('post', '/api/integrations/slack/test', tokenFor('usr_int_admin_a'));
    expect(res.status).toBe(400);
    expect(res.body.error).not.toContain('internal.test');
    expect(res.body.error).not.toContain('secret123');
  });
});
