import Redis from "ioredis";

let redis = null;
const PREFIX = "crm:cache:";
const DEFAULT_TTL = 300;
const REDIS_URL =
  process.env.REDIS_URL ||
  (process.env.REDIS_ENABLED === "true" ? "redis://127.0.0.1:6380" : null);

export function initCache() {
  if (!REDIS_URL) return;

  try {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    redis
      .connect()
      .then(() => console.log("[cache] Redis connected on", REDIS_URL))
      .catch(() => {
        console.warn("[cache] Redis unavailable — caching disabled");
        redis = null;
      });
    redis.on("error", () => {});
    redis.on("close", () => {});
  } catch {
    redis = null;
  }
}

export function cacheGet(key) {
  if (!redis) return Promise.resolve(null);
  return redis
    .get(PREFIX + key)
    .then((v) => (v ? JSON.parse(v) : null))
    .catch(() => null);
}

export function cacheSet(key, value, ttl = DEFAULT_TTL) {
  if (!redis) return Promise.resolve();
  return redis
    .set(PREFIX + key, JSON.stringify(value), "EX", ttl)
    .catch(() => {});
}

export function cacheDel(key) {
  if (!redis) return Promise.resolve();
  return redis.del(PREFIX + key).catch(() => {});
}

export function cacheFlush(pattern) {
  if (!redis) return Promise.resolve();
  return redis
    .keys(PREFIX + (pattern || "*"))
    .then((keys) => {
      if (keys.length) return redis.del(...keys);
    })
    .catch(() => {});
}
