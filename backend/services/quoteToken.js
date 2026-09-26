import crypto from 'node:crypto';

function getSigningSecret() {
  return process.env.JWT_SECRET || process.env.APP_SECRET || 'tunaxa-quote-sign-secret';
}

/**
 * Creates a signed, time-limited token for quote electronic signatures.
 *
 * @param {string} quoteId
 * @param {object} [options]
 * @param {number} [options.expiresInMs] - TTL in milliseconds (default: 7 days)
 * @param {object} [options.extra] - Additional payload metadata
 * @returns {string} Token formatted as "base64url(payload).base64url(hmac)"
 */
export function createQuoteSignToken(quoteId, options = {}) {
  if (!quoteId) {
    throw new Error('quoteId is required to create a quote signing token');
  }

  const secret = getSigningSecret();
  const exp = Date.now() + (Number(options.expiresInMs) || 7 * 24 * 60 * 60 * 1000);

  const payload = {
    quoteId,
    exp,
    ...(options.extra || {}),
  };

  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');

  return `${payloadPart}.${signature}`;
}

/**
 * Verifies a quote signing token in constant time.
 *
 * @param {string} token
 * @param {string} [expectedQuoteId]
 * @returns {{ valid: boolean, payload?: object, error?: string }}
 */
export function verifyQuoteSignToken(token, expectedQuoteId) {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'invalid' };
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return { valid: false, error: 'invalid' };
  }

  const [payloadPart, signaturePart] = parts;
  if (!payloadPart || !signaturePart) {
    return { valid: false, error: 'invalid' };
  }

  const secret = getSigningSecret();
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');

  const sigBuf = Buffer.from(signaturePart, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, error: 'invalid' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch (_) {
    return { valid: false, error: 'invalid' };
  }

  if (expectedQuoteId && payload.quoteId !== expectedQuoteId) {
    return { valid: false, error: 'mismatch', payload };
  }

  if (typeof payload.exp === 'number' && Date.now() > payload.exp) {
    return { valid: false, error: 'expired', payload };
  }

  return { valid: true, payload };
}

/**
 * Generates a public signing share link for a quote.
 *
 * @param {string} quoteId
 * @param {object} [options]
 * @param {string} [options.baseUrl] - Base URL prefix (e.g. "https://app.tunaxa.com")
 * @returns {string} URL formatted as "/quotes/:id/sign?token=..."
 */
export function createQuoteShareLink(quoteId, options = {}) {
  const token = createQuoteSignToken(quoteId, options);
  const baseUrl = options.baseUrl ? options.baseUrl.replace(/\/+$/, '') : '';
  return `${baseUrl}/quotes/${quoteId}/sign?token=${token}`;
}
