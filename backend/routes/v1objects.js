import { createObject, getObject, updateObject, deleteObject, listObjects, searchObjects, validateProperties, getPropertyDefinitions, batchCreate, batchUpsert, getObjectsSince } from '../db/store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { broadcast } from './sse.js';

export default function registerV1ObjectRoutes(app) {

  // ============================================
  // Static sub-routes (before :id)
  // ============================================

  // GET /api/v1/objects/:type/schema
  app.get('/api/v1/objects/:type/schema', auth, async (req, res) => {
    try {
      const defs = await getPropertyDefinitions(req.params.type);
      res.json({ object_type: req.params.type, fields: defs });
    } catch (err) {
      console.error(`[v1] GET /api/v1/objects/${req.params.type}/schema:`, err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/v1/objects/:type/sync?cursor=...
  app.get('/api/v1/objects/:type/sync', auth, async (req, res) => {
    const objectType = req.params.type;
    const { cursor, limit = 100 } = req.query;

    if (!cursor) {
      return res.status(400).json({ error: 'cursor query parameter is required (ISO timestamp)' });
    }

    try {
      const objects = await getObjectsSince(objectType, cursor, { limit: Math.min(Number(limit), 100), workspaceId: req.user.workspaceId || 'default' });
      const nextCursor = objects.length > 0 ? objects[objects.length - 1].updated_at : null;
      res.json({
        data: objects,
        total: objects.length,
        cursor,
        next_cursor: nextCursor,
        has_more: objects.length === Math.min(Number(limit), 100),
      });
    } catch (err) {
      console.error(`[v1] GET /api/v1/objects/${objectType}/sync:`, err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ============================================
  // Batch (must be before :id routes)
  // ============================================

  // POST /api/v1/objects/:type/batch/create
  app.post('/api/v1/objects/:type/batch/create', auth, requireRole('admin', 'member'), async (req, res) => {
    const objectType = req.params.type;
    const items = req.body;

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Request body must be a JSON array' });
    }
    if (items.length === 0) {
      return res.status(400).json({ error: 'Array must not be empty' });
    }
    if (items.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 items per batch' });
    }

    const allErrors = [];
    for (let i = 0; i < items.length; i++) {
      if (!items[i] || typeof items[i] !== 'object' || Array.isArray(items[i])) {
        allErrors.push({ index: i, error: 'Each item must be a JSON object' });
        continue;
      }
      const errors = await validateProperties(objectType, items[i]);
      if (errors.length) allErrors.push({ index: i, errors });
    }
    if (allErrors.length) {
      return res.status(400).json({ error: 'Validation failed', details: allErrors });
    }

    try {
      const created = await batchCreate(objectType, items, req.user.workspaceId || 'default');
      res.status(201).json({ data: created, created: created.length });
    } catch (err) {
      console.error(`[v1] POST /api/v1/objects/${objectType}/batch/create:`, err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/v1/objects/:type/batch/update
  app.post('/api/v1/objects/:type/batch/update', auth, requireRole('admin', 'member'), async (req, res) => {
    const objectType = req.params.type;
    const items = req.body;

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Request body must be a JSON array' });
    }
    if (items.length === 0) {
      return res.status(400).json({ error: 'Array must not be empty' });
    }
    if (items.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 items per batch' });
    }

    const allErrors = [];
    for (let i = 0; i < items.length; i++) {
      if (!items[i] || typeof items[i] !== 'object' || Array.isArray(items[i])) {
        allErrors.push({ index: i, error: 'Each item must be a JSON object' });
        continue;
      }
      if (!items[i].id) {
        allErrors.push({ index: i, error: 'Each item must have an id' });
        continue;
      }
      const { id, ...props } = items[i];
      const errors = await validateProperties(objectType, props, { partial: true });
      if (errors.length) allErrors.push({ index: i, errors });
    }
    if (allErrors.length) {
      return res.status(400).json({ error: 'Validation failed', details: allErrors });
    }

    try {
      const updated = await batchUpsert(objectType, items, { workspaceId: req.user.workspaceId || 'default' });
      res.status(201).json({ data: updated, updated: updated.length });
    } catch (err) {
      console.error(`[v1] POST /api/v1/objects/${objectType}/batch/update:`, err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ============================================
  // List — GET /api/v1/objects/:type
  // ============================================
  app.get('/api/v1/objects/:type', auth, async (req, res) => {
    const objectType = req.params.type;
    const { limit = 100, offset = 0, q } = req.query;

    try {
      if (q) {
        const results = await searchObjects(objectType, q, { limit: Math.min(Number(limit), 100), workspaceId: req.user.workspaceId || 'default' });
        return res.json({ data: results, total: results.length });
      }

      const filters = {};
      for (const [key, value] of Object.entries(req.query)) {
        if (!['limit', 'offset', 'q', 'orderBy', 'orderDir'].includes(key)) {
          filters[key] = value;
        }
      }

      const result = await listObjects(objectType, {
        limit: Math.min(Number(limit), 100),
        offset: Number(offset),
        orderBy: req.query.orderBy || 'created_at',
        orderDir: req.query.orderDir || 'DESC',
        filters,
        workspaceId: req.user.workspaceId || 'default',
      });

      res.json(result);
    } catch (err) {
      console.error(`[v1] GET /api/v1/objects/${objectType}:`, err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ============================================
  // Get — GET /api/v1/objects/:type/:id
  // ============================================
  app.get('/api/v1/objects/:type/:id', auth, async (req, res) => {
    try {
      const obj = await getObject(req.params.id);
      if (!obj) return res.status(404).json({ error: 'Object not found' });
      if (obj.object_type !== req.params.type) {
        return res.status(404).json({ error: 'Object not found in this type' });
      }
      res.json(obj);
    } catch (err) {
      console.error(`[v1] GET /api/v1/objects/${req.params.type}/${req.params.id}:`, err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ============================================
  // Create — POST /api/v1/objects/:type
  // ============================================
  app.post('/api/v1/objects/:type', auth, requireRole('admin', 'member'), async (req, res) => {
    const objectType = req.params.type;

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    const errors = await validateProperties(objectType, req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    try {
      const obj = await createObject(objectType, req.body, req.user.workspaceId || 'default');
      broadcast('v1object.created', { type: objectType, item: obj });
      res.status(201).json(obj);
    } catch (err) {
      console.error(`[v1] POST /api/v1/objects/${objectType}:`, err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ============================================
  // Update — PATCH /api/v1/objects/:type/:id
  // ============================================
  app.patch('/api/v1/objects/:type/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const objectType = req.params.type;

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    const errors = await validateProperties(objectType, req.body, { partial: true });
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    try {
      const existing = await getObject(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Object not found' });
      if (existing.object_type !== objectType) {
        return res.status(404).json({ error: 'Object not found in this type' });
      }

      const updated = await updateObject(req.params.id, req.body);
      broadcast('v1object.updated', { type: objectType, item: updated });
      res.json(updated);
    } catch (err) {
      console.error(`[v1] PATCH /api/v1/objects/${objectType}/${req.params.id}:`, err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ============================================
  // Delete — DELETE /api/v1/objects/:type/:id
  // ============================================
  app.delete('/api/v1/objects/:type/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    try {
      const existing = await getObject(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Object not found' });
      if (existing.object_type !== req.params.type) {
        return res.status(404).json({ error: 'Object not found in this type' });
      }

      await deleteObject(req.params.id);
      broadcast('v1object.deleted', { type: req.params.type, id: req.params.id });
      res.json({ ok: true, deleted: req.params.id });
    } catch (err) {
      console.error(`[v1] DELETE /api/v1/objects/${req.params.type}/${req.params.id}:`, err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
