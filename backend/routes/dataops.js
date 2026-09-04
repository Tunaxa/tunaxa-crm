import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { now } from '../helpers.js';
import { cacheFlush } from '../services/cache.js';
import { createRateLimiter } from '../services/rateLimit.js';

const norm = value => String(value || '').trim().toLowerCase();
const emailEquals = (record, email) => norm(record.customerEmail) === email || norm(record.email) === email || norm(record.contact) === email;

export default function registerDataOpsRoutes(app) {
  app.get('/api/duplicates', auth, requireRole('admin', 'member'), async (req, res) => {
    const resource = req.query.resource === 'companies' ? 'companies' : 'contacts';
    const db = await readDb();
    const rows = db[resource] || [];
    const byKey = new Map();
    for (const row of rows) {
      const key = norm(resource === 'companies' ? row.name : (row.email || row.name));
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(row);
    }
    const duplicates = [...byKey.values()]
      .filter(group => group.length > 1)
      .map(group => ({ ids: group.map(x => x.id), names: group.map(x => resource === 'companies' ? x.name : (x.name || x.email)) }));
    res.json({ resource, duplicates, total: duplicates.reduce((n, g) => n + g.ids.length, 0) });
  });

  app.post('/api/duplicates/merge', auth, requireRole('admin', 'member'), async (req, res) => {
    const { resource, keepId, mergeId } = req.body || {};
    if (!['contacts', 'companies'].includes(resource)) return res.status(400).json({ error: 'Invalid resource' });
    if (!keepId || !mergeId || keepId === mergeId) return res.status(400).json({ error: 'keepId and mergeId are required and distinct' });
    const result = await mutateDb(db => {
      const rows = db[resource] || [];
      const keep = rows.find(r => r.id === keepId);
      const merge = rows.find(r => r.id === mergeId);
      if (!keep || !merge) return { error: 'One or both records not found' };
      for (const key of Object.keys(merge)) {
        if (key === 'id') continue;
        if ((keep[key] === undefined || keep[key] === null || keep[key] === '') && merge[key] !== undefined && merge[key] !== '') keep[key] = merge[key];
      }
      keep.updatedAt = now();
      db[resource] = rows.filter(r => r.id !== mergeId);
      return { keep };
    });
    if (result.error) return res.status(404).json({ error: result.error });
    cacheFlush(resource);
    res.json(result.keep);
  });

  app.post('/api/portal/access', createRateLimiter({ windowMs: 60_000, max: 25, prefix: 'portal' }), async (req, res) => {
    const email = norm(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const db = await readDb();
    const contact = (db.contacts || []).find(c => norm(c.email) === email) || null;
    const pick = rows => (rows || []).filter(r => emailEquals(r, email));
    res.json({
      customer: { email, name: contact?.name || email },
      quotes: pick(db.quotes),
      contracts: pick(db.contracts),
      invoices: pick(db.invoices),
      tickets: pick(db.tickets)
    });
  });
}
