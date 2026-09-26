import crypto from "node:crypto";
import Redis from "ioredis";

let redis = null;
const PREFIX = "crm:cache:";
const REDIS_URL =
  process.env.REDIS_URL ||
  (process.env.REDIS_ENABLED === "true" ? "redis://127.0.0.1:6380" : null);

function logCacheError(operation, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[cache] ${operation} failed: ${message}`);
}

function normalizeForHash(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => normalizeForHash(item));
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((normalized, key) => {
        if (value[key] !== undefined) {
          normalized[key] = normalizeForHash(value[key]);
        }
        return normalized;
      }, {});
  }
  return value;
}

export function hashParams(params = {}) {
  try {
    const normalized = normalizeForHash(params);
    if (
      !normalized ||
      typeof normalized !== "object" ||
      Object.keys(normalized).length === 0
    ) {
      return "all";
    }
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex")
      .slice(0, 16);
  } catch (error) {
    logCacheError("hashParams", error);
    return "all";
  }
}

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
      .catch((error) => {
        logCacheError("connect", error);
        console.warn("[cache] Redis unavailable — caching disabled");
        redis = null;
      });
    redis.on("error", () => {});
    redis.on("close", () => {});
  } catch (error) {
    logCacheError("init", error);
    redis = null;
  }
}

export function cacheGet(key) {
  if (!redis) return Promise.resolve(null);
  try {
    return redis
      .get(PREFIX + key)
      .then((v) => (v ? JSON.parse(v) : null))
      .catch((error) => {
        logCacheError("get", error);
        return null;
      });
  } catch (error) {
    logCacheError("get", error);
    return Promise.resolve(null);
  }
}

export function cacheSet(key, value, ttlSeconds = 60) {
  if (!redis) return Promise.resolve();
  try {
    return redis
      .set(PREFIX + key, JSON.stringify(value), "EX", ttlSeconds)
      .catch((error) => {
        logCacheError("set", error);
      });
  } catch (error) {
    logCacheError("set", error);
    return Promise.resolve();
  }
}

export function cacheDel(key) {
  if (!redis) return Promise.resolve();
  try {
    return redis.del(PREFIX + key).catch((error) => {
      logCacheError("delete", error);
    });
  } catch (error) {
    logCacheError("delete", error);
    return Promise.resolve();
  }
}

export function cacheFlush(pattern) {
  if (!redis) return Promise.resolve();
  try {
    return redis
      .keys(PREFIX + (pattern || "*"))
      .then((keys) => {
        if (keys.length) return redis.del(...keys);
      })
      .catch((error) => {
        logCacheError("flush", error);
      });
  } catch (error) {
    logCacheError("flush", error);
    return Promise.resolve();
  }
}
