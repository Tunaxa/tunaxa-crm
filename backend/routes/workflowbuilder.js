import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now } from '../helpers.js';
import { dryRunFlow, EVENT_META, ACTION_META, NODE_META } from '../services/workflows.js';
import { broadcast } from './sse.js';
import { repoFor } from '../db/repositories/index.js';

function clean(flow) {
  const cleaned = {
    ...flow,
    nodes: Array.isArray(flow.nodes) ? flow.nodes : [],
    edges: Array.isArray(flow.edges) ? flow.edges : []
  };
  delete cleaned._workflow;
  return cleaned;
}

function validateGraphPayload(body, { requireNodes = false, requireEdges = false } = {}) {
  if (body.nodes !== undefined && !Array.isArray(body.nodes)) return 'nodes must be an array';
  if (body.edges !== undefined && !Array.isArray(body.edges)) return 'edges must be an array';
  if (requireNodes && !Array.isArray(body.nodes)) return 'nodes array is required';
  if (requireEdges && !Array.isArray(body.edges)) return 'edges array is required';
  if (Array.isArray(body.nodes) && body.nodes.some(node => (
    !node || typeof node !== 'object' || typeof node.id !== 'string' || !node.id || typeof node.type !== 'string' || !node.type
  ))) return 'each node must include a non-empty string id and type';
  if (Array.isArray(body.edges) && body.edges.some(edge => (
    !edge || typeof edge !== 'object' || typeof edge.source !== 'string' || !edge.source || typeof edge.target !== 'string' || !edge.target
  ))) return 'each edge must include non-empty string source and target';
  return null;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true' || value === '1';
}

async function createWorkflow(req, res, { requireGraph = false } = {}) {
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'Workflow name is required' });
  const graphError = validateGraphPayload(body, requireGraph ? { requireNodes: true, requireEdges: true } : {});
  if (graphError) return res.status(400).json({ error: graphError });
  const saved = await mutateDb(db => {
    const item = {
      id: id('workflow'),
      name: body.name,
      description: body.description || '',
      event: body.event || '',
      filter: body.filter || {},
      nodes: Array.isArray(body.nodes) ? body.nodes : [],
      edges: Array.isArray(body.edges) ? body.edges : [],
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
}

async function getWorkflow(req, res) {
  const db = await readDb();
  const flow = (db.workflows || []).find(f => f.id === req.params.id);
  if (!flow) return res.status(404).json({ error: 'Workflow not found' });
  res.json(clean(flow));
}

async function getWorkflowRuns(req, res) {
  const db = await readDb();
  const flow = (db.workflows || []).find(f => f.id === req.params.id);
  if (!flow) return res.status(404).json({ error: 'Workflow not found' });

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;
  const workspaceId = req.user?.workspaceId || req.user?.workspace_id;

  const repo = repoFor('workflowRuns');
  if (!repo) {
    return res.json({ data: [], total: 0, page, limit, totalPages: 0 });
  }

  const runs = await repo.findByWorkflowId(req.params.id, { page, limit, workspaceId });
  res.json(runs);
}

async function updateWorkflow(req, res) {
  const body = req.body || {};
  const graphError = validateGraphPayload(body);
  if (graphError) return res.status(400).json({ error: graphError });
  const saved = await mutateDb(db => {
    const flow = (db.workflows || []).find(f => f.id === req.params.id);
    if (!flow) return null;
    Object.assign(flow, body, { id: flow.id });
    if (Array.isArray(body.nodes)) flow.nodes = body.nodes;
    if (Array.isArray(body.edges)) flow.edges = body.edges;
    if (!Array.isArray(flow.nodes)) flow.nodes = [];
    if (!Array.isArray(flow.edges)) flow.edges = [];
    if (Array.isArray(body.actions)) flow.actions = body.actions;
    flow.updatedAt = now();
    db.audit.unshift({ id: id('audit'), action: `Updated workflow "${flow.name}"`, actor: req.user.name, createdAt: now() });
    return flow;
  });
  if (!saved) return res.status(404).json({ error: 'Workflow not found' });
  broadcast('workflow.updated', { id: saved.id });
  res.json(saved);
}

export default function registerWorkflowBuilderRoutes(app) {
  app.get('/api/workflows/meta', auth, async (req, res) => {
    res.json({ events: EVENT_META, actions: ACTION_META, nodes: NODE_META });
  });

  app.get('/api/workflows', auth, async (req, res) => {
    const db = await readDb();
    res.json((db.workflows || []).map(clean));
  });

  app.post('/api/workflows', auth, requireRole('admin', 'member'), (req, res) => createWorkflow(req, res));

  app.post('/api/workflowbuilder', auth, requireRole('admin', 'member'), (req, res) => (
    createWorkflow(req, res, { requireGraph: true })
  ));

  app.get('/api/workflows/:id', auth, (req, res) => getWorkflow(req, res));

  app.get('/api/workflows/:id/runs', auth, requireRole('admin', 'member'), (req, res) => getWorkflowRuns(req, res));

  app.get('/api/workflowbuilder/:id', auth, (req, res) => getWorkflow(req, res));

  app.put('/api/workflows/:id', auth, requireRole('admin', 'member'), (req, res) => updateWorkflow(req, res));

  app.put('/api/workflowbuilder/:id', auth, requireRole('admin', 'member'), (req, res) => updateWorkflow(req, res));

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
    broadcast('workflow.deleted', { id: req.params.id }, req.user.workspaceId || 'default');
    res.json({ ok: true });
  });

  // Save the node graph for the visual builder
  app.put('/api/workflows/:id/graph', auth, requireRole('admin', 'member'), async (req, res) => {
    const body = req.body || {};
    const graphError = validateGraphPayload(body, { requireNodes: true });
    if (graphError) return res.status(400).json({ error: graphError });
    const saved = await mutateDb(db => {
      const flow = (db.workflows || []).find(f => f.id === req.params.id);
      if (!flow) return null;
      flow.nodes = body.nodes;
      if (Array.isArray(body.edges)) flow.edges = body.edges;
      if (!Array.isArray(flow.edges)) flow.edges = [];
      if (body.event) flow.event = body.event;
      if (body.filter) flow.filter = body.filter;
      flow.updatedAt = now();
      return flow;
    });
    if (!saved) return res.status(404).json({ error: 'Workflow not found' });
    broadcast('workflow.graph_saved', { id: saved.id }, req.user.workspaceId || 'default');
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