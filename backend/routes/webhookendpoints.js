import crypto from 'node:crypto';
import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now } from '../helpers.js';
import { cacheFlush } from '../services/cache.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { triggerWorkflows } from '../services/workflows.js';
import { broadcast } from './sse.js';

const publicLimiter = createRateLimiter({ windowMs: 60_000, max: 300, prefix: 'hooks' });

function parseFlag(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true' || value === '1';
}

function publicUrl(token) {
  return `${process.env.BASE_URL || 'http://127.0.0.1:3001'}/api/hooks/${token}`;
}

export default function registerWebhookEndpointRoutes(app) {
  app.get('/api/webhookEndpoints', auth, async (_req, res) => {
    const db = await readDb();
    const rows = (db.webhookEndpoints || []).map(w => ({ ...w, url: publicUrl(w.token) }));
    res.json(rows);
  });

  app.post('/api/webhookEndpoints', auth, requireRole('admin', 'member'), async (req, res) => {
    const body = req.body || {};
    if (!body.name) return res.status(400).json({ error: 'name is required' });
    const saved = await mutateDb(db => {
      if (!db.webhookEndpoints) db.webhookEndpoints = [];
      const item = {
        id: id('webhook'),
        token: `whk_${crypto.randomBytes(16).toString('hex')}`,
        name: body.name,
        description: body.description || '',
        enabled: parseFlag(body.enabled, true),
        requestCount: 0,
        lastStatus: null,
        lastReceivedAt: null,
        createdAt: now(),
        createdBy: req.user.name,
        updatedAt: now()
      };
      db.webhookEndpoints.unshift(item);
      db.audit.unshift({ id: id('audit'), action: `Created webhook endpoint "${item.name}"`, actor: req.user.name, createdAt: now() });
      return { ...item, url: publicUrl(item.token) };
    });
    broadcast('webhook.created', { id: saved.id });
    res.status(201).json(saved);
  });

  app.put('/api/webhookEndpoints/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const body = req.body || {};
    const saved = await mutateDb(db => {
      const item = (db.webhookEndpoints || []).find(w => w.id === req.params.id);
      if (!item) return null;
      if (body.name !== undefined) item.name = body.name;
      if (body.description !== undefined) item.description = body.description;
      if (body.enabled !== undefined) item.enabled = parseFlag(body.enabled, true);
      item.updatedAt = now();
      return { ...item, url: publicUrl(item.token) };
    });
    if (!saved) return res.status(404).json({ error: 'Webhook endpoint not found' });
    broadcast('webhook.updated', { id: saved.id });
    res.json(saved);
  });

  app.delete('/api/webhookEndpoints/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const ok = await mutateDb(db => {
      const index = (db.webhookEndpoints || []).findIndex(w => w.id === req.params.id);
      if (index < 0) return false;
      db.webhookEndpoints.splice(index, 1);
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'Webhook endpoint not found' });
    cacheFlush('webhookEndpoints');
    broadcast('webhook.deleted', { id: req.params.id });
    res.json({ ok: true });
  });

  // Public inbound trigger: POST /api/hooks/:token
  app.post('/api/hooks/:token', publicLimiter, async (req, res) => {
    const token = String(req.params.token || '');
    const db = await readDb();
    const endpoint = (db.webhookEndpoints || []).find(w => w.token === token);
    if (!endpoint || !endpoint.enabled) return res.status(404).json({ error: 'Webhook not found' });

    const payload = req.body || {};
    const receivedAt = now();
    const delivery = { id: id('delivery'), endpointId: endpoint.id, payload, receivedAt, status: 'received' };

    await mutateDb(db => {
      if (!db.webhookDeliveries) db.webhookDeliveries = [];
      db.webhookDeliveries.unshift(delivery);
      const current = (db.webhookEndpoints || []).find(w => w.id === endpoint.id);
      if (current) {
        current.requestCount = (current.requestCount || 0) + 1;
        current.lastStatus = 'received';
        current.lastReceivedAt = receivedAt;
        current.updatedAt = receivedAt;
      }
      db.audit.unshift({ id: id('audit'), action: `Webhook "${endpoint.name}" received a delivery`, actor: 'Webhook', createdAt: receivedAt });
    });

    triggerWorkflows('webhookEndpoints', 'webhook.received', { endpoint: { ...endpoint, requestCount: (endpoint.requestCount || 0) + 1 }, payload, receivedAt }).catch(() => {});
    broadcast('webhook.received', { endpointId: endpoint.id, deliveryId: delivery.id });

    res.status(200).json({ ok: true, endpoint: endpoint.name, deliveryId: delivery.id, receivedAt });
  });

  // Recent deliveries for an endpoint
  app.get('/api/webhookDeliveries', auth, async (req, res) => {
    const db = await readDb();
    let rows = db.webhookDeliveries || [];
    if (req.query.endpointId) rows = rows.filter(d => d.endpointId === req.query.endpointId);
    res.json(rows.slice(0, 50));
  });
}
