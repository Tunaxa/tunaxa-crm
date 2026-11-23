import { repoFor } from '../db/repositories/index.js';
import { decodeTrackingToken, isSafeDestinationUrl } from '../services/tracking.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { now } from '../helpers.js';

const TRANSPARENT_1X1_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);
const OPEN_THROTTLE_MS = 5000;
const MAX_RECENT_OPENS = 10000;

export const trackingLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 300,
  prefix: 'tracking',
});

export { OPEN_THROTTLE_MS, MAX_RECENT_OPENS };

export function pruneRecentOpens(map, nowMs = Date.now()) {
  for (const [key, seenAt] of map) {
    if (nowMs - seenAt >= OPEN_THROTTLE_MS) map.delete(key);
  }
  while (map.size >= MAX_RECENT_OPENS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function sendTrackingPixel(res) {
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': String(TRANSPARENT_1X1_GIF.length),
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.status(200).end(TRANSPARENT_1X1_GIF);
}

function requestContext(req) {
  return {
    userAgent: req.headers['user-agent'] || '',
    ip: req.ip || '',
  };
}

async function resolveContact(payload) {
  if (!payload.contactId) return null;
  const contact = await repoFor('contacts').findById(payload.contactId, payload.workspaceId);
  if (!contact || contact.workspace_id !== payload.workspaceId) return null;
  return contact;
}

async function recordActivity(payload, type, req, contact, metadata, description) {
  const { userAgent, ip } = requestContext(req);
  const stamp = now();
  await repoFor('activities').create({
    workspace_id: payload.workspaceId,
    type,
    title: type === 'email_open' ? 'Email opened' : 'Email link clicked',
    subject: type === 'email_open' ? 'Email opened' : 'Email link clicked',
    description,
    contact_id: contact?.id ?? null,
    deal_id: payload.dealId || null,
    direction: 'inbound',
    entity_type: contact ? 'contact' : null,
    entity_id: contact?.id ?? null,
    metadata: {
      messageId: payload.messageId || null,
      targetUrl: payload.targetUrl || null,
      ...metadata,
      userAgent,
      ip,
      ...(type === 'email_open' ? { openedAt: stamp } : { clickedAt: stamp }),
    },
  });
}

export default function registerTrackingRoutes(app) {
  const recentOpens = new Map();

  app.get('/api/tracking/open/:token', trackingLimiter, async (req, res) => {
    const payload = decodeTrackingToken(req.params.token);
    if (payload) {
      try {
        const nowMs = Date.now();
        pruneRecentOpens(recentOpens, nowMs);
        const throttleKey = `${payload.workspaceId}:${payload.messageId || payload.contactId || ''}`;
        const lastSeen = recentOpens.get(throttleKey);
        if (lastSeen === undefined || nowMs - lastSeen >= OPEN_THROTTLE_MS) {
          recentOpens.set(throttleKey, nowMs);
          const contact = await resolveContact(payload);
          const description = `Recipient opened email${payload.messageId ? ` (${payload.messageId})` : ''}`;
          await recordActivity(payload, 'email_open', req, contact, {}, description);
        }
      } catch (error) {
        console.error('[tracking] failed to record email_open:', error?.message || error);
      }
    }
    sendTrackingPixel(res);
  });

  app.get('/api/tracking/click/:token', trackingLimiter, async (req, res) => {
    const payload = decodeTrackingToken(req.params.token);
    if (!payload) return res.status(400).json({ error: 'Invalid or expired tracking token' });
    const targetUrl = payload.targetUrl;
    const approvedTargets = new Set();
    if (isSafeDestinationUrl(targetUrl)) approvedTargets.add(targetUrl);
    if (!approvedTargets.has(targetUrl)) {
      return res.status(400).json({ error: 'Invalid or unsafe destination URL' });
    }

    try {
      const contact = await resolveContact(payload);
      const description = `Recipient clicked link: ${targetUrl}`;
      await recordActivity(payload, 'email_click', req, contact, { targetUrl }, description);
    } catch (error) {
      console.error('[tracking] failed to record email_click:', error?.message || error);
    }

    return res.redirect(302, targetUrl);
  });
}
