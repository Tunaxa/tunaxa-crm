import { readDb } from '../store.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function sessionExpiresAt() {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
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
    if (!session || sessionIsExpired(session)) return res.status(401).json({ error: 'Session expired' });
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
