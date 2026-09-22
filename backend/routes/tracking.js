import express from 'express';
import { readDb, mutateDb } from '../store.js';
import { now } from '../helpers.js';

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const NO_CACHE = {
  'Content-Type': 'image/gif',
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

const isTokenRef = value => /^[0-9a-f]{32}$/i.test(String(value || ''));

// Skips token handlers (next('route')) so legacy :messageId routes keep matching.
function tokenGuard(req, res, next) {
  if (isTokenRef(req.params.ref)) return next();
  next('route');
}

function validateRedirectUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

async function recordTokenEvent(token, type, event) {
  await mutateDb(db => {
    const records = db.emailTracking || [];
    const rec = records.find(r => r.token === token);
    if (!rec) return;
    if (type === 'open') {
      rec.openCount = (rec.openCount || 0) + 1;
      rec.firstOpenedAt = rec.firstOpenedAt || now();
      rec.lastOpenedAt = now();
      rec.updatedAt = now();
    } else {
      rec.clicks = rec.clicks || [];
      rec.clicks.push({ ...event, clickedAt: now() });
      rec.lastClickedAt = now();
      rec.updatedAt = now();
    }
    db.trackingEvents = db.trackingEvents || [];
    db.trackingEvents.unshift({ id: `track_${Date.now()}`, token, type, createdAt: now(), ...(event || {}) });
  }).catch(() => {});
}

export default function createTrackingRouter() {
  const router = express.Router();

  // Token-based tracking (new)
  router.get('/open/:ref', tokenGuard, async (req, res) => {
    const { ref: token } = req.params;
    await recordTokenEvent(token, 'open');
    res.writeHead(200, NO_CACHE);
    res.end(PIXEL);
  });

  router.get('/click/:ref', tokenGuard, async (req, res) => {
    const { ref: token } = req.params;
    const target = validateRedirectUrl(req.query.url);
    if (!target) return res.status(400).json({ error: 'Invalid redirect URL' });
    await recordTokenEvent(token, 'click', {
      url: target.toString(),
      userAgent: req.headers['user-agent'] || null,
    });
    res.redirect(302, target.toString());
  });

  // Legacy messageId tracking (kept functional; deprecated — see PR note)
  router.get('/open/:messageId', async (req, res) => {
    const { messageId } = req.params;
    await mutateDb(db => {
      const msg = db.messages.find(m => m.id === messageId);
      if (msg) {
        msg.openedAt = msg.openedAt || now();
        msg.openCount = (msg.openCount || 0) + 1;
        msg.updatedAt = now();
      }
      if (!db.trackingEvents) db.trackingEvents = [];
      db.trackingEvents.unshift({ id: `track_${Date.now()}`, messageId, type: 'open', createdAt: now() });
    });
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    res.end(PIXEL);
  });

  router.get('/click/:messageId', async (req, res) => {
    const { messageId } = req.params;
    const url = req.query.url || '/';
    await mutateDb(db => {
      const msg = db.messages.find(m => m.id === messageId);
      if (msg) {
        msg.clickedAt = msg.clickedAt || now();
        msg.clickCount = (msg.clickCount || 0) + 1;
        msg.updatedAt = now();
      }
      if (!db.trackingEvents) db.trackingEvents = [];
      db.trackingEvents.unshift({ id: `track_${Date.now()}`, messageId, type: 'click', url, createdAt: now() });
    });
    res.redirect(302, url);
  });

  router.get('/events', async (req, res) => {
    const db = await readDb();
    const { messageId, token, type } = req.query;
    let events = db.trackingEvents || [];
    if (messageId) events = events.filter(e => e.messageId === messageId);
    if (token) events = events.filter(e => e.token === token);
    if (type) events = events.filter(e => e.type === type);
    res.json(events.slice(0, 200));
  });

  return router;
}