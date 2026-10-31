// Origin / Referer enforcement for state-changing requests (OWASP A01 + A05).
//
// Threat model note, because it changes what this middleware is worth: this app
// authenticates with an opaque bearer token held in localStorage and sent as
// `Authorization: Bearer ...`. Browsers do not attach Authorization headers
// automatically, so a cross-site attacker cannot make a victim's browser
// authenticate a forged request the way cookie auth allows. That makes the app
// not classically CSRF-vulnerable *today*.
//
// It is still enforced, for three reasons:
//   1. It is the control that stops mattering the moment auth moves to cookies,
//      which is the usual next step for a browser client.
//   2. It blocks cross-origin state changes from a hostile page even when a
//      token has leaked into a page the attacker controls.
//   3. It is a cheap, explicit statement of which origins may drive the API.
//
// Rules:
//   - Safe methods (GET/HEAD/OPTIONS) are never blocked; a cross-origin GET that
//     returned data would be a CORS problem, not a CSRF one.
//   - Requests with no Origin AND no Referer are allowed through. Those are
//     non-browser clients: curl, mobile apps, server-to-server calls, and the
//     test suite. Blocking them would break every legitimate integration while
//     stopping nothing, since they carry no ambient credentials.
//   - Same-origin is always allowed, compared against the request's own Host (and
//     scheme, where determinable) so the app works on any hostname it is
//     deployed behind without config.
//   - Everything else must match an explicitly allowed origin.
//
// The exempt list exists because this API deliberately exposes a public,
// cross-origin surface: public form embeds, the tracking pixel, the live chat
// widget, emailed quote-signing links, public booking pages, the customer
// portal, and machine-to-machine webhook receivers (Twilio, /api/hooks/:token).
// Enforcing an origin check on those would break the product, and they are not
// CSRF targets -- they carry no ambient user credential, they are the intended
// entry point for anonymous third-party traffic.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Paths that are anonymous and/or intentionally reachable from other sites.
// Matched against req.path (no query string) and anchored at the start.
const EXEMPT_PATTERNS = [
  /^\/api\/twilio\//, // Twilio voice/status/recording callbacks
  /^\/api\/hooks\//, // webhook receiver, authenticated by the path token
  /^\/api\/web\//, // tracking pixel: fires from any site and any email client
  /^\/api\/livechat\//, // chat widget embedded on third-party pages
  /^\/api\/forms\/[^/]+\/submit$/, // public form embeds
  /^\/api\/scheduler\/public\//, // public booking pages
  /^\/api\/quotes\/[^/]+\/sign$/, // emailed quote-signing link
  /^\/api\/portal\//, // customer portal
];

// Development defaults. Production must set APP_URL; without it only
// same-origin is accepted, which fails closed for a browser client served from a
// different host than the API.
const DEV_ORIGINS = ["http://localhost:3000", "http://localhost:5173"];

function configuredOrigins(env = process.env) {
  const raw = env.APP_URL || env.CLIENT_URL || "";
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Origins this process will accept, from config plus dev defaults. */
export function allowedOrigins(env = process.env) {
  // Development origins are a convenience for the Vite dev server, never a
  // production trust anchor: a page served from localhost:5173 is not part of
  // any real deployment, and honouring it in production would hand an attacker
  // a known-good origin to host a CSRF page on (a local dev server, a stray
  // localhost listener, or a browser extension). In production only
  // APP_URL/CLIENT_URL are trusted.
  const dev = env.NODE_ENV === "production" ? [] : DEV_ORIGINS;
  return new Set([...dev, ...configuredOrigins(env)]);
}

export function isExemptPath(path) {
  return EXEMPT_PATTERNS.some((pattern) => pattern.test(path));
}

function hostOf(req) {
  const host = req.headers.host;
  if (!host) return null;
  // req.headers.host may be "example.com:3000"; protocol is irrelevant because
  // the Origin comparison below is done host-only.
  return host.toLowerCase();
}

function hostOfUrl(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function schemeOfUrl(url) {
  try {
    // URL.protocol carries a trailing colon ("https:"); req.protocol does not.
    return new URL(url).protocol.toLowerCase().replace(/:$/, "");
  } catch {
    return null;
  }
}

/**
 * The scheme the request was actually addressed to.
 *
 * `req.protocol` already accounts for `app.set("trust proxy", ...)`; the
 * forwarded header is consulted as a fallback for deployments that terminate
 * TLS somewhere Express does not know about. Returns null when undeterminable,
 * in which case callers fall back to host-only matching rather than rejecting
 * every request.
 */
function schemeOf(req) {
  const proto = req.get?.("x-forwarded-proto") || req.protocol || null;
  if (!proto) return null;
  return String(proto).split(",")[0].trim().toLowerCase().replace(/:$/, "");
}

/**
 * True when `origin` refers to the same origin the request was addressed to.
 *
 * Scheme is compared too when it is known on both sides: a page served over
 * plain http from the same host is a *different* origin, and accepting it would
 * let anyone who can inject into http:// traffic drive authenticated writes
 * against an https deployment. When the request scheme cannot be determined
 * (some proxy topologies) this degrades to host-only matching.
 */
function isSameOrigin(origin, req) {
  const originHost = hostOfUrl(origin);
  const requestHost = hostOf(req);
  if (!originHost || !requestHost || originHost !== requestHost) return false;

  const originScheme = schemeOfUrl(origin);
  const requestScheme = schemeOf(req);
  if (originScheme && requestScheme) return originScheme === requestScheme;
  return true;
}

/**
 * Express middleware enforcing the rules above.
 *
 * @param {{ allow?: (origin: string, req: import('express').Request) => boolean }} [options]
 *   `allow` lets a deployment widen or narrow the policy without editing this
 *   file; it is the supported hook for tests and for unusual proxy topologies.
 */
export function originGuard(options = {}) {
  const allow = typeof options.allow === "function" ? options.allow : null;

  return function enforceOrigin(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    if (isExemptPath(req.path)) return next();

    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const presented = origin || referer;

    // No Origin and no Referer: a non-browser client. Nothing to forge.
    if (!presented) return next();

    if (allow && allow(presented, req)) return next();

    // Relative or malformed Origin values are not browser-generated.
    if (!/^https?:\/\//i.test(presented)) return next();

    if (isSameOrigin(presented, req)) return next();
    if (allowedOrigins().has(presented)) return next();

    return res.status(403).json({ error: "Cross-origin request forbidden" });
  };
}

export default originGuard;
