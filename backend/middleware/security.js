/**
 * Pure Origin/Referer helper predicates used by
 * `backend/__tests__/security-headers-csrf.test.js`.
 *
 * The authoritative CSRF guard is `originGuard()` in `./csrf.js`, and it is the
 * only guard mounted by `backend/server.js`. This module exists solely so the
 * trust-matching rules can be unit-tested without booting the app; it must not
 * be mounted as runtime middleware.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Re-export the canonical exempt list so tests assert against the same patterns
// the runtime guard uses instead of a drifting copy.
export { EXEMPT_PATTERNS as PUBLIC_CROSS_ORIGIN_PATHS } from "./csrf.js";

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i;

export function isSafeMethod(method) {
  return SAFE_METHODS.has(String(method || "").toUpperCase());
}

/**
 * Reduce a header value to a comparable `scheme://host[:port]` string.
 * Works for both `Origin` and the full-URL `Referer`. Returns null for
 * anything untrustworthy, including the literal `null` origin.
 */
export function normalizeOrigin(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // URL drops default ports, so http://a:80 and http://a normalize alike.
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return null;
  }
}

export function parseAllowedOrigins(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeOrigin)
    .filter(Boolean);
}

export function isLoopbackOrigin(origin) {
  try {
    return LOOPBACK_HOST.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function hostnameOf(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * @param {string} origin raw `Origin` header value
 * @param {{allowed?: string[], allowLoopback?: boolean, selfOrigin?: string|null, selfHost?: string|null}} [options]
 */
export function isTrustedOrigin(origin, options = {}) {
  const { allowed = [], allowLoopback = false, selfOrigin = null, selfHost = null } = options;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (selfOrigin && normalized === selfOrigin) return true;
  // Compare on hostname too: behind a TLS-terminating proxy `req.protocol` is
  // http while the browser reports https, and the hostname is still ours.
  const host = hostnameOf(normalized);
  if (selfHost && host && host === selfHost.toLowerCase()) return true;
  if (allowed.includes(normalized)) return true;
  if (allowLoopback && isLoopbackOrigin(normalized)) return true;
  return false;
}
