import { readDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { getRevisions } from '../services/revisions.js';

export default function registerRevisionRoutes(app) {
  app.get('/api/revisions', auth, async (req, res) => {
    const db = await readDb();
    const { resource, recordId, limit } = req.query;
    const revisions = getRevisions(db, { resource, recordId, limit: Number(limit) || 50 });
    res.json({ data: revisions, total: revisions.length });
  });

  app.get('/api/revisions/:resource/:recordId', auth, async (req, res) => {
    const db = await readDb();
    const revisions = getRevisions(db, { resource: req.params.resource, recordId: req.params.recordId, limit: 100 });
    res.json({ data: revisions, total: revisions.length });
  });

  app.get('/api/revisions/field/:resource/:field', auth, async (req, res) => {
    const db = await readDb();
    const revisions = (db.revisions || []).filter(r => r.resource === req.params.resource && r.changes.some(c => c.field === req.params.field));
    res.json({ data: revisions.slice(0, 100), total: revisions.length });
  });
}