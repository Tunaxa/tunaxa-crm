import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now } from '../helpers.js';
import { matchCondition, matchConditions } from '../services/conditions.js';

const RESOURCES = ['leads', 'contacts', 'companies', 'deals', 'tasks'];

function recordMatches(record, definition) {
  return matchConditions(record, definition.conditions, definition.logic);
}

export function evaluateList(records, definition) {
  const rows = rowsFrom(records);
  return rows.filter(record => recordMatches(record, definition));
}

function rowsFrom(records) {
  // Normalize records -> array of objects; used internally by evaluateList
  if (Array.isArray(records)) return records;
  const map = records || {};
  return Object.values(map).filter(Array.isArray).flat().concat(Object.values(records).filter(r => r && typeof r === 'object' && !Array.isArray(r)) || []);
}

export default function registerListRoutes(app) {
  // ============ Static Lists ============
  app.get('/api/lists', auth, async (req, res) => {
    const db = await readDb();
    const lists = db.lists || [];
    res.json({ data: lists, total: lists.length });
  });

  app.post('/api/lists', auth, requireRole('admin', 'member'), async (req, res) => {
    const { name, type = 'static', resource = 'leads' } = req.body || {};
    if (!name) return res.status(400).json({ error: 'List name is required' });
    const list = await mutateDb(db => {
      if (!db.lists) db.lists = [];
      const item = { id: id('list'), name, type, resource, condition: '', conditions: [], logic: 'all', memberIds: [], createdAt: now(), createdBy: req.user.name, updatedAt: now() };
      db.lists.unshift(item);
      return item;
    });
    res.status(201).json(list);
  });

  // Add members to a static list
  app.post('/api/lists/:id/members', auth, requireRole('admin', 'member'), async (req, res) => {
    const ids = req.body.ids;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array is required' });
    const list = await mutateDb(db => {
      const found = (db.lists || []).find(l => l.id === req.params.id);
      if (!found) return null;
      found.memberIds = [...new Set([...(found.memberIds || []), ...ids])];
      found.updatedAt = now();
      return found;
    });
    if (!list) return res.status(404).json({ error: 'List not found' });
    res.json(list);
  });

  // Remove a member from a static list
  app.delete('/api/lists/:id/members/:memberId', auth, requireRole('admin', 'member'), async (req, res) => {
    const list = await mutateDb(db => {
      const found = (db.lists || []).find(l => l.id === req.params.id);
      if (!found) return null;
      found.memberIds = (found.memberIds || []).filter(x => x !== req.params.memberId);
      found.updatedAt = now();
      return found;
    });
    if (!list) return res.status(404).json({ error: 'List not found' });
    res.json(list);
  });

  // Update a list's definition (used for smart lists)
  app.put('/api/lists/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const list = await mutateDb(db => {
      const found = (db.lists || []).find(l => l.id === req.params.id);
      if (!found) return null;
      if (req.body.name) found.name = req.body.name;
      if (req.body.resource) found.resource = req.body.resource;
      found.conditions = Array.isArray(req.body.conditions) ? req.body.conditions : found.conditions;
      found.logic = req.body.logic || found.logic;
      found.memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds : found.memberIds;
      found.updatedAt = now();
      return found;
    });
    if (!list) return res.status(404).json({ error: 'List not found' });
    res.json(list);
  });

  app.delete('/api/lists/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const result = await mutateDb(db => {
      const index = (db.lists || []).findIndex(l => l.id === req.params.id);
      if (index < 0) return false;
      db.lists.splice(index, 1);
      return true;
    });
    if (!result) return res.status(404).json({ error: 'List not found' });
    res.json({ ok: true });
  });

  // ============ Evaluate a list against live records ============
  app.get('/api/lists/:id/members', auth, async (req, res) => {
    const db = await readDb();
    const list = (db.lists || []).find(l => l.id === req.params.id);
    if (!list) return res.status(404).json({ error: 'List not found' });

    if (list.type === 'static') {
      const records = (db[list.resource] || []).filter(r => (list.memberIds || []).includes(r.id));
      return res.json({ data: records, total: records.length, type: 'static' });
    }

    // Smart list — evaluate query against all records of the resource
    const records = (db[list.resource] || []).filter(r => recordMatches(r, list));
    res.json({ data: records, total: records.length, type: 'smart' });
  });

  // Refresh a smart list — re-evaluate & persist member snapshot
  app.post('/api/lists/:id/refresh', auth, requireRole('admin', 'member'), async (req, res) => {
    const list = await mutateDb(db => {
      const found = (db.lists || []).find(l => l.id === req.params.id);
      if (!found) return null;
      const records = db[found.resource] || [];
      const matched = records.filter(r => recordMatches(r, found));
      if (found.type === 'smart') found.memberIds = matched.map(r => r.id);
      found.lastEvaluatedAt = now();
      found.lastCount = matched.length;
      found.updatedAt = now();
      return found;
    });
    if (!list) return res.status(404).json({ error: 'List not found' });
    res.json(list);
  });

  // ============ Segment explorer ============
  app.post('/api/segments/evaluate', auth, requireRole('admin', 'member'), async (req, res) => {
    const { resource = 'leads', conditions = [], logic = 'all' } = req.body || {};
    if (!RESOURCES.includes(resource)) return res.status(400).json({ error: `resource must be one of: ${RESOURCES.join(', ')}` });
    const db = await readDb();
    const records = (db[resource] || []).filter(r => recordMatches(r, { conditions, logic }));
    res.json({ data: records, total: records.length });
  });
}