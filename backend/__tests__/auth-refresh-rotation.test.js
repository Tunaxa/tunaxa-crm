import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb } from './setup.js';
import { mutateDb, readDb } from '../store.js';
import { REFRESH_COOKIE, hashRefreshToken, issueSessionPair } from '../services/refreshTokens.js';

let app;

const OWNER = { email: 'owner@test.com', password: 'secret123' };

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
});

afterAll(() => cleanupTestDb());

// supertest keeps no cookie jar, so every request has to carry the cookie
// explicitly - which also proves each request is independently authenticated.
function refreshCookie(res) {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  for (const entry of list) {
    if (!entry.startsWith(`${REFRESH_COOKIE}=`)) continue;
    const parts = entry.split(';').map(part => part.trim());
    const attrs = {};
    for (const attr of parts.slice(1)) {
      const index = attr.indexOf('=');
      attrs[(index < 0 ? attr : attr.slice(0, index)).toLowerCase()] =
        index < 0 ? true : attr.slice(index + 1);
    }
    return {
      raw: parts[0],
      value: decodeURIComponent(parts[0].slice(parts[0].indexOf('=') + 1)),
      attrs,
    };
  }
  return null;
}

async function login(credentials = OWNER) {
  const res = await request(app).post('/api/auth/login').send(credentials);
  return { res, cookie: refreshCookie(res) };
}

// express clears a cookie by re-sending it empty with a past Expires, so an
// absent header and an emptied cookie are not the same thing.
function refreshCookieCleared(res) {
  const cookie = refreshCookie(res);
  return Boolean(cookie) && cookie.value === '' && Boolean(cookie.attrs.expires);
}

// Seeds an extra device without spending the login rate-limit budget.
function seedDevice() {
  return mutateDb(db => {
    const user = db.users.find(candidate => candidate.email === OWNER.email);
    if (!user) throw new Error(`missing seeded user ${OWNER.email}`);
    return issueSessionPair(db, user.id);
  });
}

describe('Refresh token issuance', () => {
  let accessToken;
  let rawRefreshToken;

  it('POST /api/auth/setup returns an access token and sets an http-only refresh cookie', async () => {
    const res = await request(app).post('/api/auth/setup').send({
      name: 'Owner',
      email: OWNER.email,
      password: OWNER.password,
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.expiresIn).toBe(3600);

    const cookie = refreshCookie(res);
    expect(cookie).toBeTruthy();
    expect(cookie.value).toMatch(/^[a-f0-9]{64}$/);
    expect(cookie.attrs.httponly).toBe(true);
    expect(String(cookie.attrs.samesite).toLowerCase()).toBe('strict');
    expect(cookie.attrs.path).toBe('/');

    accessToken = res.body.token;
    rawRefreshToken = cookie.value;
  });

  it('issues short-lived access tokens instead of 30 day sessions', async () => {
    const db = await readDb();
    const session = db.sessions.find(candidate => candidate.token === accessToken);
    expect(session).toBeTruthy();
    expect(session.purpose).toBe('access');
    // createdAt and expiresAt are stamped a moment apart, so allow a second of drift.
    const ttlSeconds = (new Date(session.expiresAt) - new Date(session.createdAt)) / 1000;
    expect(ttlSeconds).toBeGreaterThan(3599);
    expect(ttlSeconds).toBeLessThan(3601);
  });

  it('stores refresh tokens hashed so a leaked store cannot be replayed', async () => {
    const db = await readDb();
    const refreshSessions = db.sessions.filter(session => session.purpose === 'refresh');
    expect(refreshSessions).toHaveLength(1);
    const stored = refreshSessions[0];
    expect(stored.token).not.toBe(rawRefreshToken);
    expect(stored.token).toBe(hashRefreshToken(rawRefreshToken));
    expect(stored.familyId).toBeTruthy();
    expect(stored.consumedAt).toBeNull();
    expect(JSON.stringify(db)).not.toContain(rawRefreshToken);
  });
});

describe('Refresh token rotation', () => {
  let accessToken;
  let firstRefresh;
  let secondRefresh;

  it('POST /api/auth/refresh rotates the cookie into a new access token', async () => {
    const setup = await login();
    accessToken = setup.res.body.token;
    firstRefresh = setup.cookie.value;

    const res = await request(app).post('/api/auth/refresh').set('Cookie', setup.cookie.raw);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.token).not.toBe(accessToken);
    expect(res.body.user.email).toBe(OWNER.email);
    expect(res.body.expiresIn).toBe(3600);

    const rotated = refreshCookie(res);
    expect(rotated.value).toBeTruthy();
    expect(rotated.value).not.toBe(firstRefresh);
    expect(rotated.attrs.httponly).toBe(true);

    secondRefresh = rotated.value;
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
  });

  it('marks the rotated token consumed and reuses the same token family', async () => {
    const db = await readDb();
    const consumed = db.sessions.find(session => session.purpose === 'refresh' && session.token === hashRefreshToken(firstRefresh));
    expect(consumed).toBeTruthy();
    expect(consumed.consumedAt).toBeTruthy();

    const current = db.sessions.find(session => session.purpose === 'refresh' && session.token === hashRefreshToken(secondRefresh));
    expect(current).toBeTruthy();
    expect(current.familyId).toBe(consumed.familyId);
    expect(current.rotatedFrom).toBe(consumed.id);
  });

  it('rejects replay of a consumed refresh token', async () => {
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: firstRefresh });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/reuse/i);
    expect(refreshCookieCleared(res)).toBe(true);
  });

  it('revokes every refresh token and access session when reuse is detected', async () => {
    // The stolen token was replayed above, so the legitimate holder is cut off too.
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: secondRefresh });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/reuse|revoked/i);

    const db = await readDb();
    expect(db.sessions.filter(session => session.purpose === 'refresh' && !session.revokedAt)).toHaveLength(0);
    expect(db.sessions.some(session => session.purpose !== 'refresh')).toBe(false);
    expect(db.audit[0].action).toMatch(/reuse detected/i);
  });
});

describe('Refresh token validation', () => {
  let cookie;

  beforeAll(async () => {
    const device = await login();
    cookie = device.cookie;
  });

  it('accepts a refresh token from the request body', async () => {
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: cookie.value });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(refreshCookie(res).value).not.toBe(cookie.value);
  });

  it('never accepts a refresh token as an access token', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${cookie.value}`);
    expect(res.status).toBe(401);
  });

  it('rejects an unknown refresh token', async () => {
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: 'f'.repeat(64) });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('rejects an expired refresh token', async () => {
    const device = await login();
    await mutateDb(db => {
      const session = db.sessions.find(item => item.token === hashRefreshToken(device.cookie.value));
      session.expiresAt = new Date(0).toISOString();
    });

    const res = await request(app).post('/api/auth/refresh').set('Cookie', device.cookie.raw);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('rejects a request with no refresh token at all', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });
});

describe('Multi-device sessions', () => {
  let first;
  let second;

  it('logging in on a new device leaves the existing device signed in', async () => {
    const seeded = await seedDevice();
    const loggedIn = await login();

    const before = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${seeded.accessToken}`);
    expect(before.status).toBe(200);

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${loggedIn.res.body.token}`);
    expect(res.status).toBe(200);

    const stillThere = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${seeded.accessToken}`);
    expect(stillThere.status).toBe(200);

    first = { accessToken: seeded.accessToken, refreshToken: seeded.refreshToken };
    second = { accessToken: loggedIn.res.body.token, cookie: loggedIn.cookie };
  });

  it('logout-all requires authentication', async () => {
    const res = await request(app).post('/api/auth/logout-all');
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/logout-all revokes every device access token', async () => {
    const res = await request(app)
      .post('/api/auth/logout-all')
      .set('Authorization', `Bearer ${first.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.revokedSessions).toBeGreaterThanOrEqual(2);

    const cleared = refreshCookie(res);
    expect(cleared).toBeTruthy();
    expect(String(cleared.attrs.httponly)).toBe('true');

    for (const token of [first.accessToken, second.accessToken]) {
      const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      expect(me.status).toBe(401);
    }
  });

  it('logout-all invalidates every device refresh token', async () => {
    const seeded = await request(app).post('/api/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(seeded.status).toBe(401);

    const loggedIn = await request(app).post('/api/auth/refresh').set('Cookie', second.cookie.raw);
    expect(loggedIn.status).toBe(401);

    const db = await readDb();
    expect(db.sessions.every(session => session.purpose === 'refresh' && session.revokedAt)).toBe(true);
  });
});

describe('Single-device logout', () => {
  it('logout revokes only the calling device refresh family', async () => {
    const first = await seedDevice();
    const second = await seedDevice();

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${first.accessToken}`)
      .set('Cookie', `${REFRESH_COOKIE}=${first.refreshToken}`);

    expect(res.status).toBe(200);
    expect(refreshCookieCleared(res)).toBe(true);

    const revoked = await request(app).post('/api/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(revoked.status).toBe(401);

    const survivor = await request(app).post('/api/auth/refresh').send({ refreshToken: second.refreshToken });
    expect(survivor.status).toBe(200);

    const otherDevice = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${second.accessToken}`);
    expect(otherDevice.status).toBe(200);
  });
});

describe('Legacy access-token refresh compatibility', () => {
  it('still rotates an access token presented in the Authorization header', async () => {
    const device = await seedDevice();

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${device.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.token).not.toBe(device.accessToken);

    const old = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${device.accessToken}`);
    expect(old.status).toBe(401);

    const next = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(next.status).toBe(200);
  });

  it('leaves the matching refresh family untouched', async () => {
    const device = await seedDevice();
    await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${device.accessToken}`)
      .expect(200);

    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: device.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });
});