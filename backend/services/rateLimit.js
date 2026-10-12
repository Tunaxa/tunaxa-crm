import { cacheIncr } from './cache.js';

const buckets = new Map();
let sweepTimer = null;

export function createRateLimiter({ windowMs = 60_000, max = 30, prefix = 'rl' } = {}) {
  return async function rateLimit(req, res, next) {
    const key = `${prefix}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const redisCount = await cacheIncr(`rate-limit:${key}`, Math.ceil(windowMs / 1000));
    if (redisCount !== null) {
      if (redisCount > max) {
        res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
        return res.status(429).json({ error: 'Too many requests, please try again shortly' });
      }
      return next();
    }

    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.started >= windowMs) {
      buckets.set(key, { started: now, count: 0, windowMs });
    }
    const current = buckets.get(key);
    current.count += 1;
    if (current.count > max) {
      res.setHeader('Retry-After', Math.ceil((current.started + windowMs - now) / 1000));
      return res.status(429).json({ error: 'Too many requests, please try again shortly' });
    }
    next();
  };
}

export function startRateLimitSweeper(intervalMs = 10 * 60 * 1000) {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.started >= bucket.windowMs || now - bucket.started >= intervalMs) buckets.delete(key);
    }
  }, intervalMs);
  sweepTimer.unref();
  return sweepTimer;
}
