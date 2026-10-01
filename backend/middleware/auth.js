import { readDb } from '../store.js';

// Access tokens are short lived; they are renewed by the refresh token cookie.
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

export function accessTokenExpiresAt() {
  return new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString();
}

export function sessionIsExpired(session) {
  return Boolean(session.expiresAt) && new Date(session.expiresAt).getTime() <= Date.now();
}

export async function cleanupExpiredSessions() {
  const { mutateDb } = await import('../store.js');
  await mutateDb(db => {
    db.sessions = db.sessions.filter(session => !sessionIsExpired(session));
  });
}

export function createAuth({ allowQueryToken = false } = {}) {
  return async function auth(req, res, next) {
    const headerToken = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const queryToken = allowQueryToken && !headerToken ? String(req.query.token || '') : '';
    const token = headerToken || queryToken;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const db = await readDb();
    const session = db.sessions.find(x => x.token === token);
    if (!session || session.revokedAt || sessionIsExpired(session)) return res.status(401).json({ error: 'Session expired' });
    // Refresh credentials are stored hashed and must never authenticate a request.
    if (session.purpose === 'refresh') return res.status(401).json({ error: 'Unauthorized' });
    if (session.purpose === 'sse' && !allowQueryToken) return res.status(401).json({ error: 'Unauthorized' });
    if (queryToken && session.purpose !== 'sse') return res.status(401).json({ error: 'Unauthorized' });
    const user = db.users.find(x => x.id === session.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    req.token = token;
    next();
  };
}

export const auth = createAuth();
