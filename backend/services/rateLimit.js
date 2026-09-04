const buckets = new Map();
let sweepTimer = null;

export function createRateLimiter({ windowMs = 60_000, max = 30, prefix = 'rl' } = {}) {
  return function rateLimit(req, res, next) {
    const key = `${prefix}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
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
