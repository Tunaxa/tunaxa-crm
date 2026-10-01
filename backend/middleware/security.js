/**
 * Security middleware: Origin/Referer validation for state-changing requests.
 *
 * CSRF is a *browser* attack: the victim agent attaches cookies and
 * credentials to a request it did not intend to make. A cross-origin
 * form/fetch/XHR targeting this API therefore carries an `Origin` header
 * naming the attacking site, which we can compare against the origins we
 * trust. Non-browser clients (webhook senders, curl, mobile/desktop apps,
 * service-to-service calls) send no `Origin` at all and are not subject to
 * CSRF, so a missing header is allowed through - rejecting it would break
 * every legitimate API consumer without adding any CSRF protection.
 *
 * Requests are blocked when:
 *   - the method is state-changing (anything other than GET/HEAD/OPTIONS), and
 *   - `Sec-Fetch-Site: cross-site` (defence in depth, for browsers that send
 *     it even when Origin is absent or spoofable), or
 *   - an `Origin`/`Referer` is present and does not resolve to a trusted
 *     origin. `Origin: null` (sandboxed iframe, `file://`) is never trusted.
 *
 * Trusted origins are, in order:
 *   1. the request's own host (so a single-origin deployment needs no config
 *      and works unchanged behind a TLS-terminating proxy), compared on
 *      hostname as well as full origin;
 *   2. `ALLOWED_ORIGINS` - a comma-separated list of extra origins, needed
 *      when the SPA is served from a different domain than the API;
 *   3. loopback origins (localhost/127.0.0.1/::1) outside production, for the
 *      Vite dev server.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Public endpoints that are *designed* to be called cross-origin from
 * customer websites (embedded forms, chat widget, tracking beacons, inbound
 * webhooks). They take no ambient credentials - each carries its own
 * permalink or token - so origin checks would only break them. They remain
 * protected by their own per-route rate limiters.
 */
export const PUBLIC_CROSS_ORIGIN_PATHS = [
  /^\/api\/hooks\/[^/]+/, // inbound webhooks, authenticated by /:token
  /^\/api\/forms\/[^/]+\/submit/, // public form embedded on a customer site
  /^\/api\/web\/(event|identify)/, // web tracking beacons
  /^\/api\/livechat\/message/, // chat widget
  /^\/api\/scheduler\/public\/[^/]+\/book/, // public booking page
];

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

function requestSelf(req) {
  const host = req.get("host");
  const proto = req.protocol || "http";
  return { origin: host ? normalizeOrigin(`${proto}://${host}`) : null, host: host || null };
}

function pathOf(req) {
  return String(req.originalUrl || req.url || "").split("?")[0];
}

/**
 * @param {{
 *   allowedOrigins?: string[],
 *   allowLoopback?: boolean,
 *   exemptPaths?: RegExp[],
 *   isExempt?: (path: string) => boolean,
 * }} [options]
 */
export function createOriginGuard(options = {}) {
  const allowed = options.allowedOrigins ?? parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
  const allowLoopback = options.allowLoopback ?? process.env.NODE_ENV !== "production";
  const exemptPaths = options.exemptPaths ?? PUBLIC_CROSS_ORIGIN_PATHS;
  const isExempt =
    options.isExempt ?? ((path) => exemptPaths.some((pattern) => pattern.test(path)));

  return function originGuard(req, res, next) {
    // Safe methods cannot mutate state, so they are never subject to CSRF.
    if (isSafeMethod(req.method)) return next();
    if (isExempt(pathOf(req))) return next();

    const secFetchSite = req.get("sec-fetch-site");
    if (secFetchSite && secFetchSite.trim().toLowerCase() === "cross-site") {
      return res.status(403).json({ error: "Forbidden: cross-site request blocked" });
    }

    const { origin: selfOrigin, host: selfHost } = requestSelf(req);
    const trust = { allowed, allowLoopback, selfOrigin, selfHost };

    const origin = req.get("origin");
    if (origin) {
      if (!isTrustedOrigin(origin, trust)) {
        return res.status(403).json({ error: "Forbidden: untrusted Origin" });
      }
      return next();
    }

    const referer = req.get("referer");
    if (referer) {
      if (!isTrustedOrigin(referer, trust)) {
        return res.status(403).json({ error: "Forbidden: untrusted Referer" });
      }
      return next();
    }

    // No Origin and no Referer: not a browser-initiated cross-origin request.
    return next();
  };
}