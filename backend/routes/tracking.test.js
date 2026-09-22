import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

import createTrackingRouter from './tracking.js';
import { injectTracking } from '../services/smtp.js';

const store = vi.hoisted(() => ({ db: null, mutateCount: 0 }));

vi.mock('../store.js', () => ({
  readDb: async () => store.db,
  mutateDb: async mutator => {
    const result = mutator(store.db);
    store.mutateCount += 1;
    return result;
  },
}));

const VALID_TOKEN = '4a1f9e2b7c8d0e3f6a5b4c3d2e1f0a9b';
const OTHER_TOKEN = '11111111111111111111111111111111';

function seedTracking(overrides = {}) {
  const record = {
    token: VALID_TOKEN,
    activityId: 'act_send_1',
    recipient: 'client@example.com',
    openCount: 0,
    firstOpenedAt: null,
    lastOpenedAt: null,
    clicks: [],
    createdAt: '2026-09-22T13:30:00.000Z',
    ...overrides,
  };
  store.db.emailTracking = store.db.emailTracking || [];
  store.db.emailTracking.unshift(record);
  return record;
}

function makeApp() {
  const app = express();
  app.use('/api/tracking', createTrackingRouter());
  return app;
}

function resetDb() {
  store.db = {
    messages: [],
    activities: [],
    emailTracking: [],
    trackingEvents: [],
  };
  store.mutateCount = 0;
}

beforeEach(() => {
  resetDb();
});

describe('GET /api/tracking/open/:token', () => {
  it('serves image/gif with strict no-cache headers', async () => {
    seedTracking();
    const app = makeApp();
    const res = await request(app).get(`/api/tracking/open/${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/gif');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.headers['cache-control']).toContain('must-revalidate');
    expect(res.headers['cache-control']).toContain('proxy-revalidate');
    expect(res.headers['cache-control']).toContain('max-age=0');
    expect(res.headers.pragma).toBe('no-cache');
    expect(res.headers.expires).toBe('0');
  });

  it('increments openCount and sets firstOpenedAt/lastOpenedAt on a valid token', async () => {
    seedTracking();
    const app = makeApp();
    await request(app).get(`/api/tracking/open/${VALID_TOKEN}`);
    const record = store.db.emailTracking.find(r => r.token === VALID_TOKEN);
    expect(record.openCount).toBe(1);
    expect(record.firstOpenedAt).toBeTruthy();
    expect(record.lastOpenedAt).toBeTruthy();
  });

  it('increments openCount on repeated opens while preserving firstOpenedAt', async () => {
    seedTracking();
    const app = makeApp();
    await request(app).get(`/api/tracking/open/${VALID_TOKEN}`);
    const first = store.db.emailTracking.find(r => r.token === VALID_TOKEN).firstOpenedAt;
    await new Promise(r => setTimeout(r, 2));
    await request(app).get(`/api/tracking/open/${VALID_TOKEN}`);
    const record = store.db.emailTracking.find(r => r.token === VALID_TOKEN);
    expect(record.openCount).toBe(2);
    expect(record.firstOpenedAt).toBe(first);
    expect(record.lastOpenedAt >= record.firstOpenedAt).toBe(true);
  });

  it('returns 200 + GIF for an unknown token without throwing', async () => {
    seedTracking();
    const app = makeApp();
    const res = await request(app).get(`/api/tracking/open/${OTHER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/gif');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('returns 200 + GIF for a missing/empty token-shaped param', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/tracking/open/00000000000000000000000000000000');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/tracking/click/:token', () => {
  it('redirects with HTTP 302 to the destination URL', async () => {
    seedTracking();
    const app = makeApp();
    const res = await request(app)
      .get(`/api/tracking/click/${VALID_TOKEN}?url=${encodeURIComponent('https://example.com/target?tab=1')}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/target?tab=1');
  });

  it('logs click details (url, timestamp, user-agent) via mutateDb', async () => {
    seedTracking();
    const app = makeApp();
    await request(app)
      .get(`/api/tracking/click/${VALID_TOKEN}?url=${encodeURIComponent('https://example.com/docs')}`)
      .set('User-Agent', 'TestAgent/1.0');
    const record = store.db.emailTracking.find(r => r.token === VALID_TOKEN);
    expect(record.clicks).toHaveLength(1);
    expect(record.clicks[0].url).toBe('https://example.com/docs');
    expect(record.clicks[0].userAgent).toBe('TestAgent/1.0');
    expect(record.clicks[0].clickedAt).toBeTruthy();
  });

  it('rejects a missing url with HTTP 400', async () => {
    seedTracking();
    const app = makeApp();
    const res = await request(app).get(`/api/tracking/click/${VALID_TOKEN}`);
    expect(res.status).toBe(400);
  });

  it('rejects relative urls with HTTP 400', async () => {
    seedTracking();
    const app = makeApp();
    const res = await request(app).get(`/api/tracking/click/${VALID_TOKEN}?url=/relative/path`);
    expect(res.status).toBe(400);
  });

  it('rejects javascript: links with HTTP 400', async () => {
    seedTracking();
    const app = makeApp();
    const res = await request(app).get(`/api/tracking/click/${VALID_TOKEN}?url=${encodeURIComponent('javascript:alert(1)')}`);
    expect(res.status).toBe(400);
  });

  it('rejects data: and malformed urls with HTTP 400', async () => {
    seedTracking();
    const app = makeApp();
    expect((await request(app).get(`/api/tracking/click/${VALID_TOKEN}?url=${encodeURIComponent('data:text/html,hi')}`)).status).toBe(400);
    expect((await request(app).get(`/api/tracking/click/${VALID_TOKEN}?url=not-a-url`)).status).toBe(400);
  });
});

describe('legacy fallback (non-breaking)', () => {
  it('still routes messageId opens to the legacy handler and increments message.openCount', async () => {
    store.db.messages.push({ id: 'message_legacy1', openCount: 0, openedAt: '', updatedAt: '' });
    const app = makeApp();
    const res = await request(app).get('/api/tracking/open/message_legacy1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/gif');
    expect(store.db.messages[0].openCount).toBe(1);
    expect(store.db.messages[0].openedAt).toBeTruthy();
  });

  it('still redirects legacy messageId clicks', async () => {
    store.db.messages.push({ id: 'message_legacy2' });
    const app = makeApp();
    const res = await request(app).get('/api/tracking/click/message_legacy2?url=https://example.com/old');
    expect(res.status).toBe(302);
    expect(store.db.messages[0].clickCount).toBe(1);
  });

  it('exposes /events filtered by token', async () => {
    seedTracking();
    const app = makeApp();
    await request(app).get(`/api/tracking/open/${VALID_TOKEN}`);
    const res = await request(app).get(`/api/tracking/events?token=${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].token).toBe(VALID_TOKEN);
    expect(res.body[0].type).toBe('open');
  });
});

describe('injectTracking', () => {
  const base = 'https://app.example.com';
  const token = VALID_TOKEN;

  it('injects the pixel immediately before </body>', () => {
    const before = '<html><body><p>hi</p></body></html>';
    const html = injectTracking(before, token, base);
    expect(html).toContain(`<img src="${base}/api/tracking/open/${token}" width="1" height="1" style="display:none !important;" alt="" /></body>`);
    expect(html.indexOf('</body>')).toBeGreaterThan(html.indexOf('width="1"'));
  });

  it('appends the pixel when no </body> exists', () => {
    const html = injectTracking('<p>only body</p>', token, base);
    expect(html).toContain(`<img src="${base}/api/tracking/open/${token}"`);
    expect(html).toBe('<p>only body</p>' + `<img src="${base}/api/tracking/open/${token}" width="1" height="1" style="display:none !important;" alt="" />`);
  });

  it('rewrites http and https hrefs to the click-tracking URL', () => {
    const html = injectTracking('<a href="https://example.com/a">A</a><a href="http://example.com/b">B</a>', token, base);
    expect(html).toContain(`href="${base}/api/tracking/click/${token}?url=${encodeURIComponent('https://example.com/a')}"`);
    expect(html).toContain(`href="${base}/api/tracking/click/${token}?url=${encodeURIComponent('http://example.com/b')}"`);
  });

  it('ignores mailto: tel: and anchor links', () => {
    const html = injectTracking('<a href="mailto:hi@example.com">mail</a><a href="tel:+123">call</a><a href="#top">top</a><a href="/docs">rel</a>', token, base);
    expect(html).toContain('href="mailto:hi@example.com"');
    expect(html).toContain('href="tel:+123"');
    expect(html).toContain('href="#top"');
    expect(html).toContain('href="/docs"');
    expect(html).not.toContain(`api/tracking/click/${token}?url=mailto`);
  });

  it('does not rewrap already-wrapped tracking URLs', () => {
    const wrapped = `<a href="${base}/api/tracking/click/${token}?url=${encodeURIComponent('https://example.com/x')}">x</a>`;
    const html = injectTracking(wrapped, token, base);
    expect((html.match(/api\/tracking\/click\//g) || []).length).toBe(1);
  });

  it('strips trailing slashes from the base url', () => {
    const html = injectTracking('<p>x</p>', token, 'https://app.example.com///');
    expect(html).toContain('src="https://app.example.com/api/tracking/open/');
  });
});