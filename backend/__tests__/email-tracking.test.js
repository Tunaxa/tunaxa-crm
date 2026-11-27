import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb } from './setup.js';
import { query } from '../db/pg.js';
import { mutateDb } from '../store.js';
import { getApiBaseUrl } from '../runtime.js';
import {
  createTrackingToken,
  verifyTrackingToken,
  generateOpenToken,
  generateClickToken,
  isSafeDestinationUrl,
  injectTrackingPixel,
  wrapTrackingLinks,
  getTrackingKey,
  TRACKING_TOKEN_TTL_MS,
} from '../services/tracking.js';
import {
  trackingLimiter,
  pruneRecentOpens,
  MAX_RECENT_OPENS,
  OPEN_THROTTLE_MS,
  broadcastTrackingUpdate,
} from '../routes/tracking.js';
import { buildTrackedHtml } from '../routes/messages.js';

const ACME = 'ws_acme';
const GLOBEX = 'ws_globex';
const SARAH_EMAIL = 'sarah.connor@cyberdyne.com';
const SARAH_ID = 'cnt_track_sarah';
const GLOBEX_ID = 'cnt_track_globex';
const BASE_URL = 'https://crm.tunaxa.com';

let pgReady = false;
try {
  await query('SELECT 1 FROM contacts LIMIT 1');
  pgReady = true;
} catch (error) {
  console.warn(
    `[email-tracking] Postgres is unreachable (${error.code || error.message}) - skipping database and HTTP assertions.`,
  );
}

describe('Tracking token & HTML utilities', () => {
  it('round-trips a signed payload and keeps the TTL default', () => {
    const token = createTrackingToken({
      contactId: SARAH_ID,
      workspaceId: ACME,
      dealId: 'deal_1',
      messageId: 'message_1',
    });
    const payload = verifyTrackingToken(token);
    expect(payload).toBeTruthy();
    expect(payload.contactId).toBe(SARAH_ID);
    expect(payload.workspaceId).toBe(ACME);
    expect(payload.dealId).toBe('deal_1');
    expect(payload.messageId).toBe('message_1');
    expect(payload.exp).toBeGreaterThan(Date.now() + TRACKING_TOKEN_TTL_MS - 5000);
  });

  it('requires a non-empty workspaceId', () => {
    expect(() => createTrackingToken({ contactId: SARAH_ID })).toThrow(/workspaceId/);
    expect(() => createTrackingToken({ contactId: SARAH_ID, workspaceId: '  ' })).toThrow(/workspaceId/);
  });

  it('generates open tokens without a target and click tokens with one', () => {
    const open = verifyTrackingToken(generateOpenToken({ contactId: SARAH_ID, workspaceId: ACME }));
    expect(open.targetUrl).toBeNull();

    const click = verifyTrackingToken(
      generateClickToken({ contactId: SARAH_ID, workspaceId: ACME, targetUrl: 'https://tunaxa.com/demo' }),
    );
    expect(click.targetUrl).toBe('https://tunaxa.com/demo');
  });

  it('rejects tampered, malformed, swapped and expired tokens', () => {
    const token = generateOpenToken({ contactId: SARAH_ID, workspaceId: ACME, messageId: 'm1' });
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyTrackingToken(tampered)).toBeNull();

    const [payloadB64, sig] = token.split('.');
    const swappedPayload = Buffer.from(
      JSON.stringify({ contactId: 'attacker', workspaceId: GLOBEX, exp: Date.now() + 100000 }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyTrackingToken(`${swappedPayload}.${sig}`)).toBeNull();
    expect(verifyTrackingToken(payloadB64)).toBeNull();
    expect(verifyTrackingToken('not-a-token')).toBeNull();
    expect(verifyTrackingToken('')).toBeNull();
    expect(verifyTrackingToken('a.b')).toBeNull();
    expect(verifyTrackingToken(`${payloadB64}.`)).toBeNull();

    const expired = generateOpenToken({ contactId: SARAH_ID, workspaceId: ACME, exp: Date.now() - 1000 });
    expect(verifyTrackingToken(expired)).toBeNull();
  });

  it('fails closed when no tracking secret is configured in production', () => {
    expect(() => getTrackingKey({ NODE_ENV: 'production' })).toThrow(/TRACKING_SECRET|JWT_SECRET/);
    expect(Buffer.isBuffer(getTrackingKey({ NODE_ENV: 'test' }))).toBe(true);
    expect(
      Buffer.isBuffer(getTrackingKey({ NODE_ENV: 'production', TRACKING_SECRET: 'unit-secret' })),
    ).toBe(true);
  });

  it('only accepts absolute http/https destinations without credentials', () => {
    expect(isSafeDestinationUrl('https://tunaxa.com/demo')).toBe(true);
    expect(isSafeDestinationUrl('http://tunaxa.com')).toBe(true);
    expect(isSafeDestinationUrl('https://user:pass@evil.example.com')).toBe(false);
    expect(isSafeDestinationUrl('http://user@evil.example.com')).toBe(false);
    expect(isSafeDestinationUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeDestinationUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isSafeDestinationUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeDestinationUrl('//evil.example.com')).toBe(false);
    expect(isSafeDestinationUrl('/relative/path')).toBe(false);
    expect(isSafeDestinationUrl('mailto:a@b.com')).toBe(false);
    expect(isSafeDestinationUrl('tel:+15551234')).toBe(false);
    expect(isSafeDestinationUrl('sms:+15551234')).toBe(false);
    expect(isSafeDestinationUrl('')).toBe(false);
    expect(isSafeDestinationUrl(null)).toBe(false);
  });

  it('injects the pixel before </body> and appends when there is no body', () => {
    const token = 'tok.en';
    const withBody = injectTrackingPixel('<html><body>Hi</body></html>', token, BASE_URL);
    expect(withBody).toContain(`<img src="${BASE_URL}/api/tracking/open/${token}"`);
    expect(withBody.indexOf('<img')).toBeLessThan(withBody.indexOf('</body>'));

    const withoutBody = injectTrackingPixel('<div>Hi</div>', token, BASE_URL);
    expect(withoutBody.endsWith('/>')).toBe(true);
    expect(withoutBody).toContain(`src="${BASE_URL}/api/tracking/open/${token}"`);
  });

  it('does not interpolate unsafe base URLs or tokens into HTML', () => {
    expect(injectTrackingPixel('<div>Hi</div>', 'tok.en', 'https://user:pass@evil.example.com')).toBe('<div>Hi</div>');
    expect(injectTrackingPixel('<div>Hi</div>', 'tok<script>.en', BASE_URL)).toBe('<div>Hi</div>');
    expect(injectTrackingPixel('<div>Hi</div>', 'tok.en', 'javascript:alert(1)')).toBe('<div>Hi</div>');
  });

  it('wraps http(s) links but preserves skipped destinations', () => {
    const html =
      '<a href="https://tunaxa.com/demo">demo</a>' +
      '<a href="mailto:sales@tunaxa.com">mail</a>' +
      '<a href="tel:+15551234">call</a>' +
      '<a href="sms:+15551234">text</a>' +
      '<a href="#section">jump</a>' +
      '<a href="https://tunaxa.com/unsubscribe?u=1">unsubscribe</a>' +
      '<a href="https://user:pass@tunaxa.com/x">credentials</a>' +
      '<a href="javascript:alert(1)">script</a>';
    const wrapped = wrapTrackingLinks(html, () => 'tok.en', BASE_URL);

    expect(wrapped).toContain(`href="${BASE_URL}/api/tracking/click/tok.en"`);
    expect(wrapped).toContain('href="mailto:sales@tunaxa.com"');
    expect(wrapped).toContain('href="tel:+15551234"');
    expect(wrapped).toContain('href="sms:+15551234"');
    expect(wrapped).toContain('href="#section"');
    expect(wrapped).toContain('href="https://tunaxa.com/unsubscribe?u=1"');
    expect(wrapped).toContain('href="https://user:pass@tunaxa.com/x"');
    expect(wrapped).toContain('href="javascript:alert(1)"');
  });

  it('evicts expired and oldest throttle entries and exposes a dedicated limiter', () => {
    const nowMs = Date.now();
    const map = new Map();
    map.set('expired', nowMs - OPEN_THROTTLE_MS - 1);
    map.set('fresh', nowMs);
    pruneRecentOpens(map, nowMs);
    expect(map.has('expired')).toBe(false);
    expect(map.has('fresh')).toBe(true);

    const big = new Map();
    for (let index = 0; index < MAX_RECENT_OPENS + 5; index += 1) big.set(`k${index}`, nowMs);
    pruneRecentOpens(big, nowMs);
    expect(big.size).toBeLessThan(MAX_RECENT_OPENS);
    expect(big.has('k0')).toBe(false);
    expect(typeof trackingLimiter).toBe('function');
  });

  it('only announces tracking refreshes with a signed workspace and message id', () => {
    expect(broadcastTrackingUpdate({ workspaceId: ACME, messageId: '' })).toBe(0);
    expect(broadcastTrackingUpdate({ workspaceId: '', messageId: 'msg_announce' })).toBe(0);
    expect(broadcastTrackingUpdate(null)).toBe(0);
  });

  it('wraps outbound email HTML using the API base fallback and skips unsubscribe links', async () => {
    const html = await buildTrackedHtml(
      'See https://tunaxa.com/demo and https://tunaxa.com/unsubscribe?u=1',
      { id: 'msg_outbound_1', to: 'nobody@example.com' },
      ACME,
      '',
    );
    const expectedBase = getApiBaseUrl().replace(/\/+$/, '');
    expect(html).toContain(`${expectedBase}/api/tracking/open/`);
    expect(html).toContain(`${expectedBase}/api/tracking/click/`);
    expect(html).toContain('href="https://tunaxa.com/unsubscribe?u=1"');
  });
});

describe.skipIf(!pgReady)('Email tracking endpoints', () => {
  let app;

  beforeAll(async () => {
    await resetTestDb();
    const mod = await import('../server.js');
    app = mod.app;
  });

  beforeEach(async () => {
    await resetTestDb();
    await query(
      `INSERT INTO contacts (id, workspace_id, first_name, last_name, email)
       VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)`,
      [SARAH_ID, ACME, 'Sarah', 'Connor', SARAH_EMAIL, GLOBEX_ID, GLOBEX, 'Kyle', 'Reese', 'kyle@globex.com'],
    );
  });

  afterAll(() => cleanupTestDb());

  it('serves a hardened 1x1 GIF with cache-busting headers and logs email_open', async () => {
    const token = generateOpenToken({ contactId: SARAH_ID, workspaceId: ACME, messageId: 'msg_open_1' });
    const res = await request(app).get(`/api/tracking/open/${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/gif');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.headers['cache-control']).toContain('must-revalidate');
    expect(res.headers['cache-control']).toContain('proxy-revalidate');
    expect(res.headers['cache-control']).toContain('max-age=0');

    const result = await query("SELECT * FROM activities WHERE type = 'email_open'");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].contact_id).toBe(SARAH_ID);
    expect(result.rows[0].workspace_id).toBe(ACME);
    expect(result.rows[0].metadata.messageId).toBe('msg_open_1');
  });

  it('records message-level email_open events when contactId is absent', async () => {
    const token = generateOpenToken({ workspaceId: ACME, messageId: 'msg_open_level' });
    await request(app).get(`/api/tracking/open/${token}`);

    const result = await query("SELECT * FROM activities WHERE type = 'email_open'");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].contact_id).toBeNull();
    expect(result.rows[0].workspace_id).toBe(ACME);
    expect(result.rows[0].metadata.messageId).toBe('msg_open_level');
  });

  it('throttles rapid duplicate opens of the same message', async () => {
    const token = generateOpenToken({ contactId: SARAH_ID, workspaceId: ACME, messageId: 'msg_spam_1' });
    await request(app).get(`/api/tracking/open/${token}`);
    await request(app).get(`/api/tracking/open/${token}`);

    const result = await query("SELECT * FROM activities WHERE type = 'email_open'");
    expect(result.rows).toHaveLength(1);
  });

  it('redirects tracked clicks with 302 and logs email_click', async () => {
    const token = generateClickToken({
      contactId: SARAH_ID,
      workspaceId: ACME,
      messageId: 'msg_click_1',
      targetUrl: 'https://tunaxa.com/demo',
    });
    const res = await request(app).get(`/api/tracking/click/${token}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://tunaxa.com/demo');

    const result = await query("SELECT * FROM activities WHERE type = 'email_click'");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].contact_id).toBe(SARAH_ID);
    expect(result.rows[0].workspace_id).toBe(ACME);
    expect(result.rows[0].metadata.targetUrl).toBe('https://tunaxa.com/demo');
  });

  it('ignores unsigned ?url overrides and uses the signed destination', async () => {
    const token = generateClickToken({
      contactId: SARAH_ID,
      workspaceId: ACME,
      targetUrl: 'https://tunaxa.com/approved',
    });
    const res = await request(app).get(`/api/tracking/click/${token}?url=https://evil.example.com/pwn`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://tunaxa.com/approved');
  });

  it('rejects credentials-in-URL destinations with 400 and records nothing', async () => {
    const token = generateClickToken({
      contactId: SARAH_ID,
      workspaceId: ACME,
      targetUrl: 'https://user:pass@evil.example.com/x',
    });
    const res = await request(app).get(`/api/tracking/click/${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or unsafe destination URL');
    const result = await query('SELECT * FROM activities');
    expect(result.rows).toHaveLength(0);
  });

  it('rejects unsafe and expired click tokens with 400', async () => {
    const unsafeTargets = ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', '//evil.example.com'];
    for (const targetUrl of unsafeTargets) {
      const token = generateClickToken({ contactId: SARAH_ID, workspaceId: ACME, targetUrl });
      const res = await request(app).get(`/api/tracking/click/${token}`);
      expect(res.status).toBe(400);
    }

    const expired = generateClickToken({
      contactId: SARAH_ID,
      workspaceId: ACME,
      targetUrl: 'https://tunaxa.com/demo',
      exp: Date.now() - 1000,
    });
    expect((await request(app).get(`/api/tracking/click/${expired}`)).status).toBe(400);

    const result = await query('SELECT * FROM activities');
    expect(result.rows).toHaveLength(0);
  });

  it('fails open for tampered open tokens and 400s on tampered click tokens', async () => {
    const openToken = generateOpenToken({ contactId: SARAH_ID, workspaceId: ACME, messageId: 'msg_tamper_1' });
    const tamperedOpen = `${openToken.slice(0, -2)}xy`;
    const openRes = await request(app).get(`/api/tracking/open/${tamperedOpen}`);
    expect(openRes.status).toBe(200);
    expect(openRes.headers['content-type']).toContain('image/gif');

    const clickToken = generateClickToken({
      contactId: SARAH_ID,
      workspaceId: ACME,
      targetUrl: 'https://tunaxa.com/demo',
    });
    const tamperedClick = `${clickToken.slice(0, -2)}xy`;
    expect((await request(app).get(`/api/tracking/click/${tamperedClick}`)).status).toBe(400);

    const result = await query('SELECT * FROM activities');
    expect(result.rows).toHaveLength(0);
  });

  it('scopes activities to the token workspace and blocks cross-tenant contact attachment', async () => {
    const acmeToken = generateOpenToken({ contactId: SARAH_ID, workspaceId: ACME, messageId: 'msg_tenant_acme' });
    const globexToken = generateOpenToken({ contactId: GLOBEX_ID, workspaceId: GLOBEX, messageId: 'msg_tenant_globex' });
    const crossTenantToken = generateOpenToken({ contactId: SARAH_ID, workspaceId: GLOBEX, messageId: 'msg_cross' });

    await request(app).get(`/api/tracking/open/${acmeToken}`);
    await request(app).get(`/api/tracking/open/${globexToken}`);
    await request(app).get(`/api/tracking/open/${crossTenantToken}`);

    const result = await query("SELECT * FROM activities WHERE type = 'email_open' ORDER BY workspace_id");
    expect(result.rows).toHaveLength(3);
    const cross = result.rows.find((row) => row.metadata.messageId === 'msg_cross');
    expect(cross.workspace_id).toBe(GLOBEX);
    expect(cross.contact_id).toBeNull();
    expect(result.rows.find((row) => row.workspace_id === ACME).contact_id).toBe(SARAH_ID);
    expect(result.rows.find((row) => row.workspace_id === GLOBEX && row.metadata.messageId === 'msg_tenant_globex').contact_id).toBe(GLOBEX_ID);
  });

  it('hydrates real workspace-scoped tracking counts and timestamps in GET /api/messages', async () => {
    const deliveredAt = new Date().toISOString();
    const inAnHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await mutateDb((db) => {
      db.users.push({
        id: 'usr_tracking',
        name: 'Tracking User',
        email: 'tracking@test.com',
        password: '',
        role: 'Owner',
        workspaceId: ACME,
        createdAt: deliveredAt,
      });
      db.sessions.push({
        token: 'tracking-token',
        userId: 'usr_tracking',
        createdAt: deliveredAt,
        expiresAt: inAnHour,
      });
      db.messages = [{
        id: 'msg_hydrate',
        workspaceId: ACME,
        channel: 'Email',
        to: SARAH_EMAIL,
        from: '',
        subject: 'Tracked proposal',
        body: 'Hello',
        direction: 'Outbound',
        status: 'Sent',
        read: true,
        createdAt: deliveredAt,
        deliveredAt,
      }];
    });

    const openToken = generateOpenToken({ workspaceId: ACME, messageId: 'msg_hydrate' });
    const clickToken = generateClickToken({
      workspaceId: ACME,
      messageId: 'msg_hydrate',
      targetUrl: 'https://tunaxa.com/demo',
    });
    const foreignToken = generateOpenToken({ workspaceId: GLOBEX, messageId: 'msg_hydrate' });
    await request(app).get(`/api/tracking/open/${openToken}`);
    await request(app).get(`/api/tracking/click/${clickToken}`);
    await request(app).get(`/api/tracking/open/${foreignToken}`);

    const res = await request(app)
      .get('/api/messages?type=email&page=1&limit=50')
      .set('Authorization', 'Bearer tracking-token');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'limit', 'page', 'total']);
    const row = res.body.data.find((item) => item.id === 'msg_hydrate');
    expect(row).toBeTruthy();
    expect(row.openCount).toBe(1);
    expect(row.clickCount).toBe(1);
    expect(row.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(row.clickedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(row.deliveredAt).toBe(deliveredAt);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(openToken);
    expect(serialized).not.toContain(clickToken);
    expect(serialized).not.toContain('userAgent');
    expect(serialized).not.toContain('Mozilla/5.0');
    expect(serialized).not.toContain('127.0.0.1');
  });

  it('defaults untracked messages to zero counts without cross-tenant bleed', async () => {
    const stamp = new Date().toISOString();
    const inAnHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await mutateDb((db) => {
      db.users.push({
        id: 'usr_tracking',
        name: 'Tracking User',
        email: 'tracking@test.com',
        password: '',
        role: 'Owner',
        workspaceId: ACME,
        createdAt: stamp,
      });
      db.sessions.push({
        token: 'tracking-token',
        userId: 'usr_tracking',
        createdAt: stamp,
        expiresAt: inAnHour,
      });
      db.messages = [{
        id: 'msg_untracked',
        workspaceId: ACME,
        channel: 'Email',
        to: SARAH_EMAIL,
        from: '',
        subject: 'Untracked',
        body: 'Hello',
        direction: 'Outbound',
        status: 'Sent',
        read: true,
        createdAt: new Date().toISOString(),
      }];
    });
    const foreignToken = generateOpenToken({ workspaceId: GLOBEX, messageId: 'msg_untracked' });
    await request(app).get(`/api/tracking/open/${foreignToken}`);

    const res = await request(app)
      .get('/api/messages?type=email')
      .set('Authorization', 'Bearer tracking-token');
    expect(res.status).toBe(200);
    const row = res.body.data.find((item) => item.id === 'msg_untracked');
    expect(row.openCount).toBe(0);
    expect(row.clickCount).toBe(0);
    expect(row.openedAt).toBe('');
    expect(row.clickedAt).toBe('');
    expect(row.deliveredAt).toBe('');
  });
});
