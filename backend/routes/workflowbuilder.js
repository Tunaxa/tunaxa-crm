import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now } from '../helpers.js';
import { dryRunFlow, EVENT_META, ACTION_META, NODE_META } from '../services/workflows.js';
import { broadcast } from './sse.js';

function clean(flow) {
  const cleaned = { ...flow };
  delete cleaned._workflow;
  return cleaned;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true' || value === '1';
}

export default function registerWorkflowBuilderRoutes(app) {
  app.get('/api/workflows/meta', auth, async (req, res) => {
    res.json({ events: EVENT_META, actions: ACTION_META, nodes: NODE_META });
  });

  app.get('/api/workflows', auth, async (req, res) => {
    const db = await readDb();
    res.json((db.workflows || []).map(clean));
  });

  app.post('/api/workflows', auth, requireRole('admin', 'member'), async (req, res) => {
    const body = req.body || {};
    if (!body.name) return res.status(400).json({ error: 'Workflow name is required' });
    const saved = await mutateDb(db => {
      const item = {
        id: id('workflow'),
        name: body.name,
        description: body.description || '',
        event: body.event || '',
        filter: body.filter || {},
        nodes: Array.isArray(body.nodes) ? body.nodes : [],
        actions: Array.isArray(body.actions) ? body.actions : [],
        enabled: parseBoolean(body.enabled, false),
        createdAt: now(),
        createdBy: req.user.name,
        updatedAt: now()
      };
      db.workflows.unshift(item);
      db.audit.unshift({ id: id('audit'), action: `Created workflow "${item.name}"`, actor: req.user.name, createdAt: now() });
      return item;
    });
    broadcast('workflow.created', { id: saved.id });
    res.status(201).json(saved);
  });

  app.get('/api/workflows/:id', auth, async (req, res) => {
    const db = await readDb();
    const flow = (db.workflows || []).find(f => f.id === req.params.id);
    if (!flow) return res.status(404).json({ error: 'Workflow not found' });
    res.json(clean(flow));
  });

  app.put('/api/workflows/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const body = req.body || {};
    const saved = await mutateDb(db => {
      const flow = (db.workflows || []).find(f => f.id === req.params.id);
      if (!flow) return null;
      Object.assign(flow, body, { id: flow.id });
      if (Array.isArray(body.nodes)) flow.nodes = body.nodes;
      if (Array.isArray(body.actions)) flow.actions = body.actions;
      flow.updatedAt = now();
      db.audit.unshift({ id: id('audit'), action: `Updated workflow "${flow.name}"`, actor: req.user.name, createdAt: now() });
      return flow;
    });
    if (!saved) return res.status(404).json({ error: 'Workflow not found' });
    broadcast('workflow.updated', { id: saved.id });
    res.json(saved);
  });

  app.delete('/api/workflows/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const result = await mutateDb(db => {
      const index = (db.workflows || []).findIndex(f => f.id === req.params.id);
      if (index < 0) return false;
      const [flow] = db.workflows.splice(index, 1);
      db.executionQueue = (db.executionQueue || []).filter(item => item.flowId !== flow.id);
      db.audit.unshift({ id: id('audit'), action: `Deleted workflow "${flow.name}"`, actor: req.user.name, createdAt: now() });
      return true;
    });
    if (!result) return res.status(404).json({ error: 'Workflow not found' });
    broadcast('workflow.deleted', { id: req.params.id });
    res.json({ ok: true });
  });

  // Save the node graph for the visual builder
  app.put('/api/workflows/:id/graph', auth, requireRole('admin', 'member'), async (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.nodes)) return res.status(400).json({ error: 'nodes array is required' });
    const saved = await mutateDb(db => {
      const flow = (db.workflows || []).find(f => f.id === req.params.id);
      if (!flow) return null;
      flow.nodes = body.nodes;
      if (body.event) flow.event = body.event;
      if (body.filter) flow.filter = body.filter;
      flow.updatedAt = now();
      return flow;
    });
    if (!saved) return res.status(404).json({ error: 'Workflow not found' });
    broadcast('workflow.graph_saved', { id: saved.id });
    res.json(saved);
  });

  app.post('/api/workflows/:id/enable', auth, requireRole('admin', 'member'), async (req, res) => {
    const saved = await mutateDb(db => {
      const flow = (db.workflows || []).find(f => f.id === req.params.id);
      if (!flow) return null;
      flow.enabled = true;
      flow.updatedAt = now();
      return flow;
    });
    if (!saved) return res.status(404).json({ error: 'Workflow not found' });
    res.json(saved);
  });

  app.post('/api/workflows/:id/disable', auth, requireRole('admin', 'member'), async (req, res) => {
    const saved = await mutateDb(db => {
      const flow = (db.workflows || []).find(f => f.id === req.params.id);
      if (!flow) return null;
      flow.enabled = false;
      flow.updatedAt = now();
      return flow;
    });
    if (!saved) return res.status(404).json({ error: 'Workflow not found' });
    res.json(saved);
  });

  // Dry-run the node graph against a sample record (no side effects)
  app.post('/api/workflows/:id/test', auth, async (req, res) => {
    const body = req.body || {};
    const db = await readDb();
    const flow = (db.workflows || []).find(f => f.id === req.params.id);
    if (!flow) return res.status(404).json({ error: 'Workflow not found' });
    const record = body.record || (flow.nodes && flow.nodes.find(n => n.type === 'start'))?.sample || {};
    const result = dryRunFlow(flow, record);
    res.json(result);
  });
}