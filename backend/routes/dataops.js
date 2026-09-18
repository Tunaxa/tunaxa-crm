import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { now } from '../helpers.js';
import { cacheFlush } from '../services/cache.js';
import { createRateLimiter } from '../services/rateLimit.js';

const norm = value => String(value || '').trim().toLowerCase();
const emailEquals = (record, email) => norm(record.customerEmail) === email || norm(record.email) === email || norm(record.contact) === email;
const compact = value => norm(value).replace(/[^a-z0-9]/g, '');

function similarity(left, right) {
  const a = compact(left);
  const b = compact(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 4 || b.length < 4) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= b.length; column++) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function duplicateScore(left, right, resource) {
  if (resource === 'contacts' && norm(left.email) && norm(left.email) === norm(right.email)) return 1;
  const leftName = left.name;
  const rightName = right.name;
  return similarity(leftName, rightName);
}

export default function registerDataOpsRoutes(app) {
  app.get('/api/duplicates', auth, requireRole('admin', 'member'), async (req, res) => {
    const resource = req.query.resource === 'companies' ? 'companies' : 'contacts';
    const db = await readDb();
    const rows = db[resource] || [];
    const groups = [];
    const visited = new Set();
    for (let index = 0; index < rows.length; index++) {
      if (visited.has(index)) continue;
      const group = [index];
      visited.add(index);
      for (let candidate = index + 1; candidate < rows.length; candidate++) {
        if (duplicateScore(rows[index], rows[candidate], resource) >= 0.8) {
          group.push(candidate);
          visited.add(candidate);
        }
      }
      if (group.length > 1) groups.push(group.map(position => rows[position]));
    }
    const duplicates = groups.map(group => {
      const pairScores = [];
      for (let left = 0; left < group.length; left++) {
        for (let right = left + 1; right < group.length; right++) {
          pairScores.push(duplicateScore(group[left], group[right], resource));
        }
      }
      return {
        ids: group.map(x => x.id),
        names: group.map(x => resource === 'companies' ? x.name : (x.name || x.email)),
        records: group,
        confidence: Math.round((pairScores.reduce((total, score) => total + score, 0) / pairScores.length) * 100)
      };
    });
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
