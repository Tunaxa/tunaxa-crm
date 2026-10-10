import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { now } from '../helpers.js';
import { cacheFlush } from '../services/cache.js';
import { createRateLimiter } from '../services/rateLimit.js';
import Fuse from 'fuse.js';
import { repoFor } from '../db/repositories/index.js';
import { PG_RESOURCES, pgToLegacy, legacyToPg } from '../db/legacy-shape.js';
import { transaction } from '../db/pg.js';

const norm = value => String(value || '').trim().toLowerCase();
// `contactEmail` is how a ticket records the requester's address, so the portal
// needs it to match at all: without it the tickets section of a customer's
// portal is always empty. None of the other portal resources carry that field,
// so widening the check only affects tickets.
const emailEquals = (record, email) =>
  norm(record.customerEmail) === email ||
  norm(record.email) === email ||
  norm(record.contactEmail) === email ||
  norm(record.contact) === email;

// Contacts, leads, companies, deals, tasks, activities, the six revenue
// resources and the six 007 marketing/service resources are served from
// Postgres rather than the JSON store (see
// migrations/004_contacts_leads.sql, 005_core_entities.sql,
// 006_revenue_tables.sql and 007_marketing_service_tables.sql), so anything
// that reads a whole resource has to go through the same repositories the write
// path uses. Reading them from readDb() would consult an empty JSON store and
// silently report zero rows while the records plainly exist in the database.
async function loadRows(resource) {
  if (!PG_RESOURCES.has(resource)) {
    const db = await readDb();
    return db[resource] || [];
  }
  const repo = repoFor(resource);
  const rows = [];
  // findAll() caps a single page at 100 rows, so page through the whole result
  // set. Stopping after one page would quietly drop duplicates beyond it.
  for (let page = 1; ; page++) {
    const result = await repo.findAll({ page, limit: 100 });
    rows.push(...result.data.map(row => pgToLegacy(row, resource)));
    if (result.data.length === 0 || rows.length >= result.total) break;
  }
  return rows;
}

export default function registerDataOpsRoutes(app) {
  app.get('/api/duplicates', auth, requireRole('admin', 'member'), async (req, res) => {
    const resource = req.query.resource === 'companies' ? 'companies' : 'contacts';
    const rows = await loadRows(resource);
    const keyOf = row => norm(resource === 'companies' ? row.name : (row.email || row.name));
    const fuzzyKeyOf = row => {
      if (resource !== 'companies' && row.email) return norm(String(row.email).split('@')[0]);
      return keyOf(row);
    };
    const displayName = row => resource === 'companies' ? row.name : (row.name || row.email);

    // Local parts shorter than this never fuzzy-match: they carry too little
    // signal and cause short-string false positives (e.g. "ab" vs "abc").
    const MIN_FUZZY_LOCAL_LEN = 4;

    // Union-find over row indices (rows keep DB order so ids[0]/names[0] stays the primary record).
    const parent = rows.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };
    const record = (a, b) => union(a, b);

    // Exact normalized matches first (Fuse raw score 0 -> confidence 1.0).
    const byKey = new Map();
    for (let i = 0; i < rows.length; i++) {
      const key = keyOf(rows[i]);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(i);
    }
    for (const group of byKey.values())
      for (let i = 1; i < group.length; i++) record(group[0], group[i]);

    // Levenshtein edit distance for length-normalized fuzzy scoring.
    const editDistance = (a, b) => {
      const m = a.length, n = b.length;
      if (m === 0) return n;
      if (n === 0) return m;
      const prev = new Array(n + 1);
      const curr = new Array(n + 1);
      for (let j = 0; j <= n; j++) prev[j] = j;
      for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= n; j++) prev[j] = curr[j];
      }
      return prev[n];
    };

    // Length-normalized raw distance in [0,1] (0 = identical). Unlike Fuse's
    // bitap score, a substring/prefix match like "alice" vs "alice.miller"
    // costs the full extra length (~0.58), so it stays above the 0.3 threshold
    // instead of scoring ~0.001 like a near-identical match.
    const fuzzyRaw = (a, b) => editDistance(a, b) / Math.max(a.length, b.length);

    // Names still fuzzy-match via Fuse bitap (threshold 0.3, ignoreFieldNorm
    // keeps the exposed score equal to Fuse's bitap score). Contact email local
    // parts are compared with the length-normalized distance above.
    const items = rows.map((row, i) => ({ i, key: fuzzyKeyOf(row) })).filter(x => x.key);
    if (resource === 'companies') {
      const fuse = new Fuse(items, { keys: ['key'], threshold: 0.3, includeScore: true, ignoreFieldNorm: true });
      for (const { i } of items) {
        const hits = fuse.search(fuzzyKeyOf(rows[i]));
        for (const hit of hits) {
          const j = hit.item.i;
          if (i === j || hit.score === undefined || hit.score > 0.3) continue;
          record(i, j);
        }
      }
    } else {
      for (let a = 0; a < items.length; a++) {
        for (let b = a + 1; b < items.length; b++) {
          const ka = items[a].key, kb = items[b].key;
          if (ka.length < MIN_FUZZY_LOCAL_LEN || kb.length < MIN_FUZZY_LOCAL_LEN) continue;
          // Edit distance is bounded below by the length difference, so pairs
          // that can't possibly fall under the threshold are skipped cheaply.
          if ((Math.abs(ka.length - kb.length) / Math.max(ka.length, kb.length)) > 0.3) continue;
          const raw = fuzzyRaw(ka, kb);
          if (raw > 0.3) continue;
          record(items[a].i, items[b].i);
        }
      }
    }

    // Raw distance [0,1] between two rows for display, always measured against
    // the primary (kept) record: exact keys short-circuit to 0; otherwise the
    // same fuzzy comparison used to group them. Returns null when the pair
    // isn't directly comparable (too short / above threshold).
    const rawBetween = (rowA, rowB) => {
      const keyA = keyOf(rowA), keyB = keyOf(rowB);
      if (keyA && keyB && keyA === keyB) return 0;
      const fa = fuzzyKeyOf(rowA), fb = fuzzyKeyOf(rowB);
      if (!fa || !fb) return null;
      if (resource === 'companies') {
        const mini = new Fuse([{ key: fb }], { keys: ['key'], threshold: 0.3, includeScore: true, ignoreFieldNorm: true });
        const hit = mini.search(fa)[0];
        return hit && hit.score <= 0.3 ? hit.score : null;
      }
      if (fa.length < MIN_FUZZY_LOCAL_LEN || fb.length < MIN_FUZZY_LOCAL_LEN) return null;
      const raw = fuzzyRaw(fa, fb);
      return raw <= 0.3 ? raw : null;
    };

    const groups = new Map();
    for (let i = 0; i < rows.length; i++) {
      if (!keyOf(rows[i])) continue;
      const root = find(i);
      if (!groups.has(root)) groups.set(root, { ids: [], names: [], idxs: [] });
      const g = groups.get(root);
      g.ids.push(rows[i].id);
      g.names.push(displayName(rows[i]));
      g.idxs.push(i);
    }
    const duplicates = [...groups.values()]
      .filter(group => group.ids.length > 1)
      .map(group => {
        const primary = rows[group.idxs[0]];
        const matches = group.idxs.slice(1).map(idx => {
          const row = rows[idx];
          const raw = rawBetween(primary, row);
          return {
            id: row.id,
            name: displayName(row),
            rawScore: raw == null ? null : Math.round(raw * 10000) / 10000,
            score: raw == null ? null : Math.round((1 - raw) * 100) / 100
          };
        });
        // Group score is kept as a sort key only: the best direct match vs primary.
        const score = Math.max(0, ...matches.map(m => m.score ?? 0));
        const records = group.idxs.map(i => rows[i]);
        const confidence = Math.round(score * 100);
        return { ids: group.ids, names: group.names, records, confidence, score, matches };
      })
      .sort((a, b) => b.score - a.score);
    res.json({ resource, duplicates, total: duplicates.reduce((n, g) => n + g.ids.length, 0) });
  });

  app.post('/api/duplicates/merge', auth, requireRole('admin', 'member'), async (req, res) => {
    const { resource, keepId, mergeId } = req.body || {};
    const mergeIds = Array.isArray(req.body?.mergeIds) ? req.body.mergeIds : (mergeId ? [mergeId] : []);
    if (!['contacts', 'companies'].includes(resource)) return res.status(400).json({ error: 'Invalid resource' });
    if (!keepId || !mergeIds.length) return res.status(400).json({ error: 'keepId and at least one mergeId are required' });
    if (mergeIds.includes(keepId)) return res.status(400).json({ error: 'keepId and mergeIds must be distinct' });
    if (new Set(mergeIds).size !== mergeIds.length) return res.status(400).json({ error: 'mergeIds must be unique' });
    if (PG_RESOURCES.has(resource)) {
      const table = resource === 'contacts' ? 'contacts' : 'companies';
      const writable = table === 'contacts'
        ? ['workspace_id', 'company_id', 'first_name', 'last_name', 'email', 'phone', 'title', 'owner_id', 'custom_fields']
        : ['workspace_id', 'name', 'domain', 'industry', 'website', 'country', 'size', 'employees', 'owner', 'custom_fields'];
      // All participants are locked and checked before either update or delete.
      const result = await transaction(async client => {
        const { rows } = await client.query(`SELECT * FROM ${table} WHERE id = ANY($1::text[]) FOR UPDATE`, [[keepId, ...mergeIds]]);
        if (rows.length !== mergeIds.length + 1) return null;
        const original = rows.find(row => row.id === keepId);
        const keep = pgToLegacy(original, resource);
        for (const mergeId of mergeIds) {
          const merge = pgToLegacy(rows.find(row => row.id === mergeId), resource);
          for (const [key, value] of Object.entries(merge)) {
            if (['id', 'createdAt', 'updatedAt'].includes(key)) continue;
            if ((keep[key] === undefined || keep[key] === null || keep[key] === '') && value !== undefined && value !== '') keep[key] = value;
          }
        }
        const data = legacyToPg(keep, resource);
        const fields = writable.filter(key => Object.hasOwn(data, key));
        const values = fields.map(key => data[key]);
        const assignments = fields.map((key, index) => `"${key}" = $${index + 1}`);
        values.push(keepId);
        const updated = await client.query(`UPDATE ${table} SET ${assignments.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`, values);
        await client.query(`DELETE FROM ${table} WHERE id = ANY($1::text[])`, [mergeIds]);
        return pgToLegacy(updated.rows[0], resource);
      });
      if (!result) return res.status(404).json({ error: 'One or both records not found' });
      await cacheFlush(`${resource}:list:*`);
      return res.json(result);
    }
    const result = await mutateDb(db => {
      const rows = db[resource] || [];
      const keep = rows.find(r => r.id === keepId);
      if (!keep) return { error: 'One or both records not found' };
      const merges = mergeIds.map(id => rows.find(r => r.id === id));
      if (merges.some(r => !r)) return { error: 'One or both records not found' };
      for (const merge of merges) {
        for (const key of Object.keys(merge)) {
          if (key === 'id') continue;
          if ((keep[key] === undefined || keep[key] === null || keep[key] === '') && merge[key] !== undefined && merge[key] !== '') keep[key] = merge[key];
        }
      }
      keep.updatedAt = now();
      db[resource] = rows.filter(r => !mergeIds.includes(r.id));
      return { keep };
    });
    if (result.error) return res.status(404).json({ error: result.error });
    cacheFlush(resource);
    res.json(result.keep);
  });

  app.post('/api/portal/access', createRateLimiter({ windowMs: 60_000, max: 25, prefix: 'portal' }), async (req, res, next) => {
    const email = norm(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Email is required' });
    try {
      // Every read goes through loadRows so the portal reflects the same
      // source of truth as the write path. Reading these arrays out of db.json
      // would return empty lists as soon as records are created, because these
      // resources are written to Postgres: contacts and leads in
      // 004_contacts_leads.sql, the revenue tables in 006_revenue_tables.sql,
      // and tickets in 007_marketing_service_tables.sql. loadRows picks the
      // right source per resource from PG_RESOURCES, so the portal covers
      // tickets with no change beyond adding the resource to that set.
      const [contactRows, quoteRows, contractRows, invoiceRows, ticketRows] = await Promise.all([
        loadRows('contacts'),
        loadRows('quotes'),
        loadRows('contracts'),
        loadRows('invoices'),
        loadRows('tickets'),
      ]);
      const pick = rows => rows.filter(r => emailEquals(r, email));
      const contact = contactRows.find(c => norm(c.email) === email) || null;
      res.json({
        customer: { email, name: contact?.name || email },
        quotes: pick(quoteRows),
        contracts: pick(contractRows),
        invoices: pick(invoiceRows),
        tickets: pick(ticketRows)
      });
    } catch (err) {
      return next(err);
    }
  });
}
