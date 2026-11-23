import crypto from 'node:crypto';

export const TRACKING_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const TRACKING_KEY_CONTEXT = 'tunaxa-email-tracking-v1';
const LOCAL_DEV_TRACKING_SECRET = 'tunaxa-crm-tracking-local-only';

export function getTrackingKey(env = process.env) {
  const baseSecret = env.TRACKING_SECRET || env.JWT_SECRET;
  if (!baseSecret) {
    if (env.NODE_ENV === 'production') {
      throw new Error('TRACKING_SECRET or JWT_SECRET must be set in production for email tracking');
    }
    return crypto.createHmac('sha256', LOCAL_DEV_TRACKING_SECRET).update(TRACKING_KEY_CONTEXT).digest();
  }
  return crypto.createHmac('sha256', String(baseSecret)).update(TRACKING_KEY_CONTEXT).digest();
}

function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(value) {
  return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function signatureFor(payloadB64) {
  return base64url(crypto.createHmac('sha256', getTrackingKey()).update(payloadB64).digest());
}

function cleanId(value) {
  if (value === undefined || value === null || value === '') return null;
  const cleaned = String(value).trim();
  return cleaned || null;
}

export function createTrackingToken(payload = {}) {
  const workspaceId = cleanId(payload.workspaceId);
  if (!workspaceId) throw new Error('workspaceId is required for email tracking tokens');
  const body = {
    contactId: cleanId(payload.contactId),
    workspaceId,
    dealId: cleanId(payload.dealId),
    messageId: cleanId(payload.messageId),
    targetUrl: payload.targetUrl ?? null,
    exp: payload.exp ?? Date.now() + TRACKING_TOKEN_TTL_MS,
  };
  const payloadB64 = base64url(JSON.stringify(body));
  return `${payloadB64}.${signatureFor(payloadB64)}`;
}

export function decodeTrackingToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, providedSignature] = parts;
  if (!payloadB64 || !providedSignature) return null;

  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(signatureFor(payloadB64));
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(fromBase64url(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (typeof payload.workspaceId !== 'string' || !payload.workspaceId.trim()) return null;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return payload;
}

export const verifyTrackingToken = decodeTrackingToken;

export function generateOpenToken({ contactId, workspaceId, dealId, messageId, exp } = {}) {
  return createTrackingToken({ contactId, workspaceId, dealId, messageId, targetUrl: null, exp });
}

export function generateClickToken({ contactId, workspaceId, dealId, messageId, targetUrl, exp } = {}) {
  return createTrackingToken({ contactId, workspaceId, dealId, messageId, targetUrl, exp });
}

export function isSafeDestinationUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || /^\/\//.test(trimmed)) return false;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  return true;
}

function safeBaseUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || /["'<>]/.test(trimmed)) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (parsed.username || parsed.password) return '';
  return parsed.origin;
}

function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

export function injectTrackingPixel(html, openToken, baseUrl) {
  const markup = String(html ?? '');
  const base = safeBaseUrl(baseUrl);
  if (!base || !safeToken(openToken)) return markup;
  const tag = `<img src="${base}/api/tracking/open/${openToken}" width="1" height="1" alt="" style="display:none;width:0;height:0;border:0;" />`;
  if (/<\/body>/i.test(markup)) return markup.replace(/<\/body>/i, `${tag}</body>`);
  return markup + tag;
}

const SKIP_HREF = /^(mailto:|tel:|sms:|#|javascript:|data:|file:)/i;
const UNSUBSCRIBE_HREF = /unsubscribe|opt[-_]?out|preferences/i;

export function wrapTrackingLinks(html, clickTokenFn, baseUrl) {
  const markup = String(html ?? '');
  const base = safeBaseUrl(baseUrl);
  if (!base) return markup;
  return markup.replace(
    /href\s*=\s*(["'])([^"']+)\1/gi,
    (match, quote, href) => {
      const target = href.trim();
      if (!target || SKIP_HREF.test(target) || UNSUBSCRIBE_HREF.test(target)) return match;
      if (!isSafeDestinationUrl(target)) return match;
      const token = clickTokenFn(target);
      if (!safeToken(token)) return match;
      return `href=${quote}${base}/api/tracking/click/${token}${quote}`;
    },
  );
}
