import { readDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { getRevisions } from '../services/revisions.js';
import { paginateAndSort } from '../helpers.js';

// Revisions are capped at 5000 in the store, so fetch the whole filtered set
// and let paginateAndSort handle paging/totals consistently with every other
// list endpoint.
const MAX_REVISIONS = 10000;

export default function registerRevisionRoutes(app) {
  app.get('/api/revisions', auth, async (req, res) => {
    const db = await readDb();
    const { resource, recordId } = req.query;
    const revisions = getRevisions(db, { resource, recordId, limit: MAX_REVISIONS });
    res.json(paginateAndSort(revisions, req.query));
  });

  app.get('/api/revisions/:resource/:recordId', auth, async (req, res) => {
    const db = await readDb();
    const revisions = getRevisions(db, { resource: req.params.resource, recordId: req.params.recordId, limit: MAX_REVISIONS });
    res.json(paginateAndSort(revisions, req.query));
  });

  app.get('/api/revisions/field/:resource/:field', auth, async (req, res) => {
    const db = await readDb();
    const revisions = (db.revisions || []).filter(r => r.resource === req.params.resource && r.changes.some(c => c.field === req.params.field));
    res.json(paginateAndSort(revisions, req.query));
  });
}