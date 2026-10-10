// Email engagement tracking: stateless, tamper-evident tokens for open pixels
// and click redirects.
//
// A tracking URL has to be verified by a public, unauthenticated endpoint, so
// the identity of the recipient cannot travel in a session - it travels inside
// the URL itself and is protected by an HMAC. The token is
//     base64url(JSON payload) . base64url(HMAC-SHA256(payload))
// which is URL-safe, deterministic, and needs no server-side state. Any edit to
// the payload (swapping the workspace, pointing targetUrl at an attacker host)
// invalidates the signature, and `verifyTrackingToken` returns null.
//
// The signing key comes from APP_SECRET (with a couple of common aliases) and
// falls back to a fixed, hashed constant so local development and the test
// suite are deterministic. The fallback is explicitly NOT a secure deployment
// secret: production must set APP_SECRET, otherwise tokens are forgeable by
// anyone who can read this source file.

import crypto from "node:crypto";

/** Tokens stay valid for 90 days - long enough for a stalled deal to engage. */
export const TRACKING_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const FALLBACK_SECRET = "tunaxa-crm-tracking-fallback-secret";

function trackingSecret(env = process.env) {
  const configured = env.APP_SECRET || env.TRACKING_SECRET || env.SESSION_SECRET;
  const seed = configured ? String(configured) : FALLBACK_SECRET;
  return crypto.createHash("sha256").update(seed).digest();
}

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(value) {
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function signatureFor(payloadB64) {
  return base64url(crypto.createHmac("sha256", trackingSecret()).update(payloadB64).digest());
}

/**
 * Serialize and sign a tracking payload.
 *
 * @param {{ contactId?: string, workspaceId?: string, dealId?: string|null,
 *           messageId?: string|null, targetUrl?: string|null, exp?: number }} payload
 * @returns {string} URL-safe "<payload>.<signature>" token
 */
export function createTrackingToken(payload = {}) {
  const body = {
    contactId: payload.contactId ?? null,
    workspaceId: payload.workspaceId ?? null,
    dealId: payload.dealId ?? null,
    messageId: payload.messageId ?? null,
    targetUrl: payload.targetUrl ?? null,
    exp: payload.exp ?? Date.now() + TRACKING_TOKEN_TTL_MS,
  };
  const payloadB64 = base64url(JSON.stringify(body));
  return `${payloadB64}.${signatureFor(payloadB64)}`;
}

/**
 * Verify a tracking token's signature and expiry.
 *
 * @returns {object|null} the decoded payload, or null when the token is
 *   malformed, tampered with, or expired.
 */
export function verifyTrackingToken(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;

  const payloadB64 = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  const expectedSignature = signatureFor(payloadB64);

  // Constant-time compare; lengths must match before timingSafeEqual runs.
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(fromBase64url(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return payload;
}

/** Open-pixel token: identifies the recipient/email but has no redirect target. */
export function generateOpenToken({ contactId, workspaceId, dealId, messageId, exp } = {}) {
  return createTrackingToken({ contactId, workspaceId, dealId, messageId, targetUrl: null, exp });
}

/** Click token: as the open token, but pinned to the destination URL. */
export function generateClickToken({ contactId, workspaceId, dealId, messageId, targetUrl, exp } = {}) {
  return createTrackingToken({ contactId, workspaceId, dealId, messageId, targetUrl, exp });
}

/**
 * Whether a redirect destination is safe to honor.
 *
 * Only absolute http/https URLs pass. Protocol-relative (`//evil.com`),
 * relative paths, and the script/data/file schemes are rejected - the classic
 * open-redirect and XSS payloads. `new URL` (without a base) throws on anything
 * that is not absolute, which is exactly the rejection we want.
 */
export function isSafeDestinationUrl(url) {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (/^\/\//.test(trimmed)) return false;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** Append the invisible open-tracking image, before </body> when present. */
export function injectTrackingPixel(html, openToken, baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const tag = `<img src="${base}/api/tracking/open/${openToken}" width="1" height="1" alt="" style="display:none;width:0;height:0;border:0;" />`;
  const markup = String(html ?? "");
  if (/<\/body>/i.test(markup)) return markup.replace(/<\/body>/i, `${tag}</body>`);
  return markup + tag;
}

const SKIP_HREF = /^(mailto:|tel:|sms:|#|javascript:|data:|file:)/i;
const UNSUBSCRIBE_HREF = /unsubscribe|opt[-_]?out|preferences/i;

/**
 * Rewrite eligible anchor hrefs to tracked click-redirect URLs.
 *
 * @param {string} html
 * @param {(targetUrl: string) => string} clickTokenFn maps a destination to a token
 * @param {string} baseUrl public API base, e.g. https://crm.example.com
 *
 * mailto:/tel:/sms:, in-page anchors, javascript:/data:/file:, and
 * unsubscribe/opt-out links are left untouched. Only absolute http/https links
 * are wrapped, and the wrapped href still carries the real destination only
 * inside the signed token - never as a query parameter an attacker could swap.
 */
export function wrapTrackingLinks(html, clickTokenFn, baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return String(html ?? "").replace(
    /href\s*=\s*(["'])([^"']+)\1/gi,
    (match, quote, href) => {
      const target = href.trim();
      if (!target || SKIP_HREF.test(target) || UNSUBSCRIBE_HREF.test(target)) return match;
      if (!isSafeDestinationUrl(target)) return match;
      const token = clickTokenFn(target);
      return `href=${quote}${base}/api/tracking/click/${token}${quote}`;
    },
  );
}
