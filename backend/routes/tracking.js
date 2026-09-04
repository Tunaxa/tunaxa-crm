import { mutateDb } from '../store.js';
import { now } from '../helpers.js';

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export default function registerTrackingRoutes(app) {
  app.get('/api/tracking/open/:messageId', async (req, res) => {
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

  app.get('/api/tracking/click/:messageId', async (req, res) => {
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

  app.get('/api/tracking/events', async (req, res) => {
    const db = await (await import('../store.js')).readDb();
    const { messageId, type } = req.query;
    let events = db.trackingEvents || [];
    if (messageId) events = events.filter(e => e.messageId === messageId);
    if (type) events = events.filter(e => e.type === type);
    res.json(events.slice(0, 200));
  });
}
