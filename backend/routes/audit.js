import { readDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';

export default function registerAuditRoutes(app) {
  app.get('/api/audit', auth, async (req, res) => {
    const db = await readDb();
    let audit = db.audit || [];
    if (req.query.actor) audit = audit.filter(a => a.actor === req.query.actor);
    if (req.query.action) audit = audit.filter(a => a.action.includes(req.query.action));
    if (req.query.from) audit = audit.filter(a => a.createdAt >= req.query.from);
    if (req.query.to) audit = audit.filter(a => a.createdAt <= req.query.to);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const items = audit.slice(offset, offset + limit).map((entry) => ({
      ...entry,
      ip: entry.ip || "",
      userAgent: entry.userAgent || "",
      resourceId: entry.resourceId || "",
    }));
    res.json({ items, total: audit.length });
  });

  app.get('/api/audit/stats', auth, async (req, res) => {
    const db = await readDb();
    const audit = db.audit || [];
    const byActor = {};
    const byAction = {};
    for (const entry of audit) {
      byActor[entry.actor] = (byActor[entry.actor] || 0) + 1;
      const actionType = entry.action.split(' ')[0] || 'other';
      byAction[actionType] = (byAction[actionType] || 0) + 1;
    }
    res.json({ total: audit.length, byActor, byAction });
  });

  app.delete('/api/audit', auth, requireAdmin, async (req, res) => {
    const { mutateDb } = await import('../store.js');
    const before = (await readDb()).audit?.length || 0;
    await mutateDb(db => { db.audit = []; });
    res.json({ cleared: before });
  });
}
