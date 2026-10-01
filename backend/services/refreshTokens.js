import crypto from 'node:crypto';
import { now, id } from '../helpers.js';
import { ACCESS_TOKEN_TTL_MS, accessTokenExpiresAt, sessionIsExpired } from '../middleware/auth.js';

// The http-only refresh cookie is the long lived credential that silently
// renews the deliberately short lived access token.
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const REFRESH_COOKIE = 'tunaxa_refresh';
export const REFRESH_PURPOSE = 'refresh';

const ACCESS_TOKEN_BYTES = 32;

// Only hashes are persisted, so a leaked db.json cannot be replayed as a token.
export function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

export function hashEquals(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function refreshExpiresAt(ttlMs = REFRESH_TOKEN_TTL_MS) {
  return new Date(Date.now() + ttlMs).toISOString();
}

export function isRefreshSession(session) {
  return session?.purpose === REFRESH_PURPOSE;
}

export function cookieIsSecure() {
  return process.env.NODE_ENV === 'production';
}

export function readCookie(header, name) {
  const raw = String(header || '');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return part.slice(index + 1).trim();
    }
  }
  return '';
}

// Resolution order matters: the http-only cookie wins over an Authorization
// header so the existing SPA client keeps refreshing silently without sending
// a long lived credential in a header.
export function readPresentedToken(req) {
  const fromCookie = readCookie(req.headers?.cookie, REFRESH_COOKIE);
  if (fromCookie) return { source: 'cookie', value: fromCookie };

  const fromBody = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : '';
  if (fromBody) return { source: 'body', value: fromBody };

  const fromHeader = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (fromHeader) return { source: 'bearer', value: fromHeader };

  return null;
}

export function setRefreshCookie(res, token, { ttlMs = REFRESH_TOKEN_TTL_MS } = {}) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieIsSecure(),
    path: '/',
    maxAge: ttlMs,
  });
}

export function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieIsSecure(),
    path: '/',
  });
}

function sessionsOf(db) {
  if (!Array.isArray(db.sessions)) db.sessions = [];
  return db.sessions;
}

function newAccessSession(db, userId) {
  const token = crypto.randomBytes(ACCESS_TOKEN_BYTES).toString('hex');
  const session = { token, userId, purpose: 'access', createdAt: now(), expiresAt: accessTokenExpiresAt() };
  db.sessions.push(session);
  return { session, token };
}

function newRefreshSession(db, userId, familyId) {
  const raw = crypto.randomBytes(ACCESS_TOKEN_BYTES).toString('hex');
  const tokenHash = hashRefreshToken(raw);
  const session = {
    id: id('rfs'),
    // Stored hashed; the raw value is only ever returned to the client once.
    token: tokenHash,
    tokenHash,
    userId,
    purpose: REFRESH_PURPOSE,
    familyId: familyId || id('fam'),
    createdAt: now(),
    expiresAt: refreshExpiresAt(),
    consumedAt: null,
    revokedAt: null,
  };
  db.sessions.push(session);
  return { session, raw };
}

export function issueSessionPair(db, userId, { familyId } = {}) {
  sessionsOf(db);
  const access = newAccessSession(db, userId);
  const refresh = newRefreshSession(db, userId, familyId);
  return {
    accessSession: access.session,
    accessToken: access.token,
    refreshSession: refresh.session,
    refreshToken: refresh.raw,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  };
}

export function findRefreshSession(db, rawToken) {
  const hash = hashRefreshToken(rawToken);
  return sessionsOf(db).find(session => isRefreshSession(session) && hashEquals(session.tokenHash || session.token, hash)) || null;
}

// Marks every refresh credential derived from the same login as revoked. Used
// on logout so the cookie can never mint another access token.
export function revokeRefreshFamily(db, session) {
  const stamp = now();
  let refresh = 0;
  for (const candidate of sessionsOf(db)) {
    if (!isRefreshSession(candidate) || candidate.familyId !== session.familyId) continue;
    if (!candidate.revokedAt) {
      candidate.revokedAt = stamp;
      refresh += 1;
    }
  }
  return { refresh };
}

export function revokeAllUserSessions(db, userId) {
  const stamp = now();
  let refresh = 0;
  for (const candidate of sessionsOf(db)) {
    if (candidate.userId !== userId || !isRefreshSession(candidate)) continue;
    if (!candidate.revokedAt) {
      candidate.revokedAt = stamp;
      refresh += 1;
    }
  }
  const kept = sessionsOf(db).filter(candidate => candidate.userId !== userId || isRefreshSession(candidate));
  const sessions = sessionsOf(db).length - kept.length;
  db.sessions = kept;
  return { refresh, sessions, total: refresh + sessions };
}

// Consumed refresh tokens are intentionally retained until their natural expiry:
// dropping them would silently disable reuse detection on the replayed token.
export function rotateRefreshToken(db, rawToken) {
  const session = findRefreshSession(db, rawToken);
  if (!session) return { error: 'Invalid refresh token' };
  if (session.revokedAt) return { error: 'Refresh token revoked' };

  if (session.consumedAt) {
    // Replay of an already-rotated token means the credential leaked. Treat it
    // as theft: burn every refresh token the user holds (the family was the
    // minimum, other devices could have been compromised too) along with all
    // live access and SSE sessions.
    const revoked = revokeAllUserSessions(db, session.userId);
    return { error: 'Refresh token reuse detected. All sessions have been revoked.', reuseDetected: true, revoked };
  }

  if (sessionIsExpired(session)) return { error: 'Refresh token expired' };

  const user = db.users.find(candidate => candidate.id === session.userId);
  if (!user) return { error: 'User not found' };

  session.consumedAt = now();
  const pair = issueSessionPair(db, user.id, { familyId: session.familyId });
  pair.refreshSession.rotatedFrom = session.id;
  return { user, ...pair };
}

// Backwards compatible path: the SPA historically refreshed by presenting its
// access token. It still rotates that session, but without touching the refresh
// family so the http-only cookie stays valid for a later silent refresh.
export function rotateLegacyAccessToken(db, token) {
  const session = sessionsOf(db).find(candidate => candidate.token === token && !isRefreshSession(candidate));
  if (!session || session.revokedAt) return { error: 'Session expired' };
  if (sessionIsExpired(session)) return { error: 'Session expired' };
  const user = db.users.find(candidate => candidate.id === session.userId);
  if (!user) return { error: 'User not found' };

  const nextToken = crypto.randomBytes(ACCESS_TOKEN_BYTES).toString('hex');
  db.sessions = sessionsOf(db).filter(candidate => candidate.token !== token);
  db.sessions.push({
    token: nextToken,
    userId: user.id,
    purpose: 'access',
    createdAt: now(),
    expiresAt: accessTokenExpiresAt(),
  });
  return { user, accessToken: nextToken, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), legacy: true };
}