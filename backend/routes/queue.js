import { readDb, mutateDb } from '../store.js';
import { findRecord } from '../db/legacy-records.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { processExecutionQueue, retryExecution } from '../services/queue.js';
import { id, now } from '../helpers.js';
import { broadcast } from './sse.js';

export default function registerExecutionRoutes(app) {
  app.get('/api/executions', auth, async (req, res) => {
    const db = await readDb();
    const { status, limit = 50 } = req.query;
    let rows = db.executionQueue || [];
    if (status) rows = rows.filter(item => item.status === status);
    rows = rows.slice(0, Math.min(Number(limit) || 50, 500));
    res.json({ data: rows, total: (db.executionQueue || []).length });
  });

  // Manually drain due queued actions
  app.post('/api/executions/process', auth, requireRole('admin', 'member'), async (req, res) => {
    const result = await processExecutionQueue();
    if (result.executed > 0) broadcast('execution.processed', result, req.user.workspaceId || 'default');
    res.json(result);
  });

  app.post('/api/executions/:id/retry', auth, requireRole('admin', 'member'), async (req, res) => {
    const item = await retryExecution(req.params.id);
    if (!item) return res.status(404).json({ error: 'Queued execution not found' });
    res.json(item);
  });

  // Clear finished items (done/failed)
  app.delete('/api/executions', auth, requireRole('admin', 'member'), async (req, res) => {
    await mutateDb(db => {
      if (!Array.isArray(db.executionQueue)) return 0;
      const before = db.executionQueue.length;
      db.executionQueue = db.executionQueue.filter(item => item.status === 'pending' || item.status === 'processing');
      return before - db.executionQueue.length;
    });
    res.json({ ok: true });
  });

  // Queue a one-off execution (used by the visual builder "Run now" for delay nodes)
  app.post('/api/executions', auth, requireRole('admin', 'member'), async (req, res) => {
    const { flowId, resource, recordId, action, dueAt } = req.body || {};
    if (!resource || !action || !action.type) return res.status(400).json({ error: 'resource and action are required' });
    // Resolved through the repository for PG-backed resources; a JSON-store
    // lookup would call every lead, contact or ticket "missing" now that those
    // tables own the data.
    const record = await findRecord(resource, recordId);
    if (recordId && !record) return res.status(400).json({ error: 'Record not found' });
    const result = await mutateDb(db => {
      const flow = (db.workflows || []).find(f => f.id === flowId);
      const item = {
        id: id('exec'),
        flowId: flowId || '',
        flowName: flow?.name || req.body.flowName || '',
        resource,
        recordId: record?.id || '',
        action,
        dueAt: dueAt || now(),
        status: 'pending',
        attempts: 0,
        createdAt: now(),
        ranAt: ''
      };
      if (!Array.isArray(db.executionQueue)) db.executionQueue = [];
      db.executionQueue.unshift(item);
      db.audit.unshift({ id: id('audit'), action: `Queued ${action.type} action`, actor: req.user.name, createdAt: now() });
      return item;
    });
    if (!result || result.error) return res.status(400).json({ error: result?.error || 'Failed to queue' });
    res.status(201).json(result);
  });
}
