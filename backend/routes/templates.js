import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now } from '../helpers.js';
import { validate, TemplateSchema } from '../services/validate.js';

export default function registerTemplateRoutes(app) {
  app.get('/api/templates', auth, async (req, res) => {
    const db = await readDb();
    res.json(db.templates || []);
  });

  app.get('/api/templates/:id', auth, async (req, res) => {
    const db = await readDb();
    const template = (db.templates || []).find(t => t.id === req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  });

  app.post('/api/templates', auth, requireRole('admin', 'member'), validate(TemplateSchema), async (req, res) => {
    const { name, subject, body, channel } = req.body;
    const template = await mutateDb(db => {
      if (!db.templates) db.templates = [];
      const t = { id: id('template'), name, subject, body, channel: channel || 'Email', createdAt: now(), updatedAt: now() };
      db.templates.unshift(t);
      return { ...t };
    });
    res.status(201).json(template);
  });

  app.put('/api/templates/:id', auth, requireRole('admin', 'member'), validate(TemplateSchema), async (req, res) => {
    const { name, subject, body, channel } = req.body;
    const updated = await mutateDb(db => {
      const index = (db.templates || []).findIndex(t => t.id === req.params.id);
      if (index < 0) return null;
      db.templates[index] = { ...db.templates[index], name, subject, body, channel: channel || db.templates[index].channel, updatedAt: now() };
      return { ...db.templates[index] };
    });
    if (!updated) return res.status(404).json({ error: 'Template not found' });
    res.json(updated);
  });

  app.delete('/api/templates/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const deleted = await mutateDb(db => {
      const index = (db.templates || []).findIndex(t => t.id === req.params.id);
      if (index < 0) return false;
      db.templates.splice(index, 1);
      return true;
    });
    if (!deleted) return res.status(404).json({ error: 'Template not found' });
    res.json({ ok: true });
  });
}
