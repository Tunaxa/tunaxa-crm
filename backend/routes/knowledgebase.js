import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now, paginateAndSort } from '../helpers.js';
import { createRateLimiter } from '../services/rateLimit.js';

const publicLimiter = createRateLimiter({ windowMs: 60_000, max: 120, prefix: 'kb' });

export default function registerKnowledgeRoutes(app) {
  app.get('/api/knowledgebase/articles', auth, async (req, res) => {
    const db = await readDb();
    const { q, category } = req.query;
    let articles = db.articles || [];
    if (q) articles = articles.filter(a => `${a.title} ${a.body} ${a.category}`.toLowerCase().includes(String(q).toLowerCase()));
    if (category) articles = articles.filter(a => a.category === category);
    const categories = [...new Set((db.articles || []).map(a => a.category).filter(Boolean))];
    res.json({ ...paginateAndSort(articles, req.query), categories });
  });

  app.get('/api/knowledgebase/articles/:id', auth, async (req, res) => {
    const db = await readDb();
    const article = (db.articles || []).find(a => a.id === req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    await mutateDb(d => {
      const found = (d.articles || []).find(a => a.id === req.params.id);
      if (found) { found.viewCount = (found.viewCount || 0) + 1; }
    });
    res.json(article);
  });

  app.post('/api/knowledgebase/articles', auth, requireRole('admin', 'member'), async (req, res) => {
    const { title, body, category = 'General', tags = [] } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
    const article = await mutateDb(db => {
      if (!db.articles) db.articles = [];
      const item = { id: id('article'), title, body, category, tags: Array.isArray(tags) ? tags : [], viewCount: 0, published: true, author: req.user.name, createdAt: now(), updatedAt: now() };
      db.articles.unshift(item);
      db.audit.unshift({ id: id('audit'), action: `Published article "${title}"`, actor: req.user.name, createdAt: now() });
      return item;
    });
    res.status(201).json(article);
  });

  app.put('/api/knowledgebase/articles/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const saved = await mutateDb(db => {
      const found = (db.articles || []).find(a => a.id === req.params.id);
      if (!found) return null;
      Object.assign(found, req.body, { updatedAt: now() });
      return found;
    });
    if (!saved) return res.status(404).json({ error: 'Article not found' });
    res.json(saved);
  });

  app.delete('/api/knowledgebase/articles/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const ok = await mutateDb(db => {
      const index = (db.articles || []).findIndex(a => a.id === req.params.id);
      if (index < 0) return false;
      db.articles.splice(index, 1);
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'Article not found' });
    res.json({ ok: true });
  });

  // Public-facing knowledge center (indexed, no auth)
  app.get('/api/kb/search', publicLimiter, async (req, res) => {
    const db = await readDb();
    const q = String(req.query.q || '').toLowerCase();
    let articles = (db.articles || []).filter(a => a.published !== false);
    if (q) articles = articles.filter(a => `${a.title} ${a.body}`.toLowerCase().includes(q));
    return res.json(paginateAndSort(articles, req.query));
  });
}