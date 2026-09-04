import { readDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { cacheGet, cacheSet } from '../services/cache.js';

export default function registerReportRoutes(app) {
  app.get('/api/reports/pipeline', auth, async (req, res) => {
    const cached = await cacheGet('report:pipeline');
    if (cached) return res.json(cached);
    const db = await readDb();
    const stages = ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
    const pipeline = stages.map(stage => {
      const deals = db.deals.filter(d => d.stage === stage);
      return {
        stage,
        count: deals.length,
        value: deals.reduce((sum, d) => sum + Number(d.value || 0), 0),
        avgValue: deals.length ? deals.reduce((sum, d) => sum + Number(d.value || 0), 0) / deals.length : 0
      };
    });
    const totalValue = pipeline.reduce((sum, s) => sum + s.value, 0);
    const activeDeals = db.deals.filter(d => !['won', 'lost'].includes(d.stage));
    const result = { pipeline, totalValue, activeDeals: activeDeals.length, wonValue: pipeline.find(s => s.stage === 'won')?.value || 0, lostValue: pipeline.find(s => s.stage === 'lost')?.value || 0 };
    cacheSet('report:pipeline', result, 120);
    res.json(result);
  });

  app.get('/api/reports/funnel', auth, async (req, res) => {
    const cached = await cacheGet('report:funnel');
    if (cached) return res.json(cached);
    const db = await readDb();
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const newLeads = db.leads.filter(l => l.createdAt >= since).length;
    const qualifiedLeads = db.leads.filter(l => l.status === 'Qualified' && l.createdAt >= since).length;
    const newContacts = db.contacts.filter(c => c.createdAt >= since).length;
    const newDeals = db.deals.filter(d => d.createdAt >= since).length;
    const wonDeals = db.deals.filter(d => d.stage === 'won' && d.updatedAt >= since).length;
    const result = {
      period: `${days} days`,
      stages: [
        { name: 'New Leads', count: newLeads },
        { name: 'Qualified', count: qualifiedLeads },
        { name: 'Contacts Created', count: newContacts },
        { name: 'Deals Opened', count: newDeals },
        { name: 'Deals Won', count: wonDeals }
      ],
      conversionRate: newLeads > 0 ? ((wonDeals / newLeads) * 100).toFixed(1) : '0'
    };
    cacheSet('report:funnel', result, 120);
    res.json(result);
  });

  app.get('/api/reports/activity', auth, async (req, res) => {
    const db = await readDb();
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const activities = db.activities.filter(a => a.createdAt >= since);
    const byType = {};
    for (const a of activities) {
      const type = a.type || 'Other';
      byType[type] = (byType[type] || 0) + 1;
    }
    const byDay = {};
    for (const a of activities) {
      const day = a.createdAt?.slice(0, 10) || 'unknown';
      byDay[day] = (byDay[day] || 0) + 1;
    }
    res.json({ total: activities.length, byType, byDay, period: `${days} days` });
  });

  app.get('/api/reports/revenue', auth, async (req, res) => {
    const db = await readDb();
    const months = parseInt(req.query.months) || 6;
    const result = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const monthKey = d.toISOString().slice(0, 7);
      const label = d.toLocaleString('en', { month: 'short', year: '2-digit' });
      const won = db.deals.filter(deal => deal.stage === 'won' && deal.updatedAt?.startsWith(monthKey));
      const lost = db.deals.filter(deal => deal.stage === 'lost' && deal.updatedAt?.startsWith(monthKey));
      const totalWon = won.reduce((sum, deal) => sum + Number(deal.value || 0), 0);
      const totalLost = lost.reduce((sum, deal) => sum + Number(deal.value || 0), 0);
      result.push({ month: monthKey, label, won: totalWon, lost: totalLost, dealsWon: won.length, dealsLost: lost.length });
    }
    res.json({ data: result, totalRevenue: result.reduce((s, r) => s + r.won, 0) });
  });

  app.get('/api/reports/team', auth, async (req, res) => {
    const db = await readDb();
    const team = {};
    for (const deal of db.deals) {
      const owner = deal.owner || 'Unassigned';
      if (!team[owner]) team[owner] = { name: owner, deals: 0, won: 0, lost: 0, value: 0, wonValue: 0 };
      team[owner].deals++;
      team[owner].value += Number(deal.value || 0);
      if (deal.stage === 'won') { team[owner].won++; team[owner].wonValue += Number(deal.value || 0); }
      if (deal.stage === 'lost') team[owner].lost++;
    }
    res.json({ members: Object.values(team).sort((a, b) => b.wonValue - a.wonValue) });
  });

  app.get('/api/reports/sources', auth, async (req, res) => {
    const db = await readDb();
    const sources = {};
    for (const lead of db.leads) {
      const src = lead.source || 'Unknown';
      if (!sources[src]) sources[src] = { name: src, count: 0, converted: 0 };
      sources[src].count++;
      if (lead.status === 'Qualified' || lead.status === 'Converted') sources[src].converted++;
    }
    res.json({ sources: Object.values(sources).sort((a, b) => b.count - a.count) });
  });
}
