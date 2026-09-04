import { createAssociation, deleteAssociation, getAssociations, getAssociationsBetween, getObject } from '../db/store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

export default function registerV1AssociationRoutes(app) {

  // POST /api/v1/associations — Create association
  app.post('/api/v1/associations', auth, requireRole('admin', 'member'), async (req, res) => {
    const { from_object_id, to_object_id, association_type, label = 'primary' } = req.body || {};

    if (!from_object_id || !to_object_id || !association_type) {
      return res.status(400).json({ error: 'from_object_id, to_object_id, and association_type are required' });
    }

    try {
      // Verify both objects exist
      const [fromObj, toObj] = await Promise.all([getObject(from_object_id), getObject(to_object_id)]);
      if (!fromObj) return res.status(404).json({ error: 'from_object not found' });
      if (!toObj) return res.status(404).json({ error: 'to_object not found' });

      const assoc = await createAssociation(from_object_id, to_object_id, association_type, label);
      res.status(201).json(assoc);
    } catch (err) {
      console.error('[v1] POST /api/v1/associations:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/v1/associations — Delete association
  app.delete('/api/v1/associations', auth, requireRole('admin', 'member'), async (req, res) => {
    const { from_object_id, to_object_id, association_type } = req.body || {};

    if (!from_object_id || !to_object_id || !association_type) {
      return res.status(400).json({ error: 'from_object_id, to_object_id, and association_type are required' });
    }

    try {
      const deleted = await deleteAssociation(from_object_id, to_object_id, association_type);
      if (!deleted) return res.status(404).json({ error: 'Association not found' });
      res.json({ ok: true, deleted: deleted.id });
    } catch (err) {
      console.error('[v1] DELETE /api/v1/associations:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/v1/objects/:type/:id/associations — Get associations for an object
  app.get('/api/v1/objects/:type/:id/associations', auth, async (req, res) => {
    try {
      const obj = await getObject(req.params.id);
      if (!obj) return res.status(404).json({ error: 'Object not found' });
      if (obj.object_type !== req.params.type) {
        return res.status(404).json({ error: 'Object not found in this type' });
      }

      const { association_type, direction } = req.query;
      const assocs = await getAssociations(req.params.id, { associationType: association_type, direction });
      res.json({ data: assocs, total: assocs.length });
    } catch (err) {
      console.error(`[v1] GET /api/v1/objects/:type/:id/associations:`, err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/v1/associations/between — Get associations between two objects
  app.get('/api/v1/associations/between', auth, async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to query params are required' });
    }

    try {
      const assocs = await getAssociationsBetween(from, to);
      res.json({ data: assocs, total: assocs.length });
    } catch (err) {
      console.error('[v1] GET /api/v1/associations/between:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
