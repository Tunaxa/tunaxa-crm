import { readDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { getSettings } from '../services/config.js';
import { createRateLimiter } from '../services/rateLimit.js';
import {
  checkOllamaStatus, suggestReplies, scoreLead, generateMeetingBrief,
  generateCallScript, generatePipelineInsights, enrichContact,
  writeSequence, autoLogActivity, smartSearch, calculateWinProbability
} from '../services/ai.js';

const aiLimiter = createRateLimiter({ windowMs: 60_000, max: 20, prefix: 'ai' });

export default function registerAiRoutes(app) {
  app.get('/api/ai/status', auth, async (req, res) => {
    const settings = await getSettings();
    const status = await checkOllamaStatus(settings);
    res.json(status);
  });

  app.post('/api/ai/replies', auth, requireRole('admin', 'member'), aiLimiter, async (req, res) => {
    try {
      const settings = await getSettings();
      const { subject, body, to, contact, history } = req.body;
      const result = await suggestReplies(settings, { subject, body, to, contact, history });
      let suggestions;
      try { suggestions = JSON.parse(result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); } catch { suggestions = [{ tone: 'Formal', text: result }]; }
      res.json({ suggestions });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/api/ai/score', auth, requireRole('admin', 'member'), aiLimiter, async (req, res) => {
    try {
      const settings = await getSettings();
      const db = await readDb();
      const { leadId, ...fields } = req.body;
      let lead = fields;
      if (leadId) {
        lead = (db.leads || []).find(l => l.id === leadId) || (db.contacts || []).find(c => c.id === leadId) || fields;
      }
      const activities = db.activities || [];
      const activityCount = activities.filter(a => a.contact === lead.name || a.contact === lead.email).length;
      const daysSinceContact = lead.createdAt ? Math.floor((Date.now() - new Date(lead.createdAt).getTime()) / 86400000) : undefined;
      const result = await scoreLead(settings, { ...lead, activityCount, daysSinceContact });
      res.json(result);
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/api/ai/meeting-brief', auth, requireRole('admin', 'member'), aiLimiter, async (req, res) => {
    try {
      const settings = await getSettings();
      const db = await readDb();
      const { contactId, contactName } = req.body;
      const name = contactName || contactId;
      const contact = (db.contacts || []).find(c => c.id === contactId || c.name === name) || (db.leads || []).find(l => l.id === contactId || l.name === name) || { name };
      const deals = (db.deals || []).filter(d => d.company === contact.company || d.contact === contact.name);
      const activities = (db.activities || []).filter(a => a.contact === contact.name || a.contact === contact.email).slice(0, 15);
      const notes = activities.filter(a => a.type === 'Note');
      const result = await generateMeetingBrief(settings, { contact, deals, activities, notes });
      res.json({ brief: result, contact });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/api/ai/call-script', auth, requireRole('admin', 'member'), aiLimiter, async (req, res) => {
    try {
      const settings = await getSettings();
      const { contact, type, product, stage } = req.body;
      const result = await generateCallScript(settings, { contact, type, product, stage });
      res.json({ script: result });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/api/ai/pipeline-insights', auth, requireRole('admin', 'member'), aiLimiter, async (req, res) => {
    try {
      const settings = await getSettings();
      const db = await readDb();
      const deals = db.deals || [];
      const activities = (db.activities || []).slice(0, 30);
      const contacts = [...(db.contacts || []), ...(db.leads || [])];
      const result = await generatePipelineInsights(settings, { deals, activities, contacts });
      res.json({ insights: result });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/api/ai/enrich', auth, requireRole('admin', 'member'), aiLimiter, async (req, res) => {
    try {
      const settings = await getSettings();
      const { name, email, company, domain } = req.body;
      const result = await enrichContact(settings, { name, email, company, domain });
      let enrichment;
      try { enrichment = JSON.parse(result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); } catch { enrichment = { enrichment_notes: result }; }
      res.json(enrichment);
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/api/ai/sequence', auth, requireRole('admin', 'member'), aiLimiter, async (req, res) => {
    try {
      const settings = await getSettings();
      const { contact, product, goal, steps } = req.body;
      const result = await writeSequence(settings, { contact, product, goal, steps });
      res.json({ sequence: result });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/api/ai/auto-log', auth, requireRole('admin', 'member'), aiLimiter, async (req, res) => {
    try {
      const settings = await getSettings();
      const { text, contact, context } = req.body;
      const result = await autoLogActivity(settings, { text, contact, context });
      let activities;
      try { activities = JSON.parse(result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); } catch { activities = [{ type: 'Note', title: 'AI extracted activity', notes: result }]; }
      res.json({ activities });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/api/ai/search', auth, requireRole('admin', 'member'), aiLimiter, async (req, res) => {
    try {
      const settings = await getSettings();
      const { query } = req.body;
      const resources = ['leads', 'contacts', 'companies', 'deals', 'activities', 'tasks', 'messages'];
      const interpretation = await smartSearch(settings, { query, resources });
      let parsed;
      try { parsed = JSON.parse(interpretation.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); } catch { parsed = { intent: query, filters: [] }; }
      const db = await readDb();
      let results = {};
      const searched = new Set();
      for (const f of (parsed.filters || [])) {
        const res = f.resource;
        if (searched.has(res)) continue;
        searched.add(res);
        const items = db[`${res}s`] || db[res] || [];
        results[res] = items.slice(0, parsed.limit || 20);
      }
      if (!Object.keys(results).length) {
        for (const r of resources) {
          const items = db[`${r}s`] || db[r] || [];
          if (items.length) results[r] = items.slice(0, 5);
        }
      }
      res.json({ interpretation: parsed, results });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/api/ai/win-probability', auth, requireRole('admin', 'member'), aiLimiter, async (req, res) => {
    try {
      const settings = await getSettings();
      const db = await readDb();
      const { dealId, deal: inputDeal } = req.body;
      const deal = dealId ? (db.deals || []).find(d => d.id === dealId) || inputDeal : inputDeal;
      const activities = (db.activities || []).filter(a => a.contact === deal?.company || a.title?.toLowerCase().includes((deal?.title || '').toLowerCase()));
      const contacts = (db.contacts || []).filter(c => c.company === deal?.company);
      const historicalDeals = (db.deals || []).filter(d => d.stage === 'won' || d.stage === 'lost');
      const result = await calculateWinProbability(settings, { deal, activities, contacts, historicalDeals });
      let parsed;
      try { parsed = JSON.parse(result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); } catch { parsed = { probability: 50, confidence: 'low', recommendation: result }; }
      res.json(parsed);
    } catch (error) { res.status(500).json({ error: error.message }); }
  });
}
