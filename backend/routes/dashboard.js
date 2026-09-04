import { readDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { LIFECYCLE_STAGES } from './lifecycle.js';

const countBy = (rows, key) => {
  const out = {};
  for (const row of rows || []) {
    const k = String(row[key] ?? '').trim() || 'None';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
};

export default function registerDashboardRoutes(app) {
  app.get('/api/dashboard/sales', auth, async (req, res) => {
    const db = await readDb();
    const days30 = new Date(Date.now() - 30 * 86400000).toISOString();
    const days7 = new Date(Date.now() - 7 * 86400000).toISOString();

    const deals = db.deals || [];
    const leads = db.leads || [];
    const activities = db.activities || [];
    const tasks = db.tasks || [];
    const team = db.team || [];

    const openDeals = deals.filter(d => d.stage && String(d.stage).toLowerCase() !== 'won' && String(d.stage).toLowerCase() !== 'lost');
    const wonDeals = deals.filter(d => String(d.stage || '').toLowerCase() === 'won');

    const dealsByStage = (db.settings?.pipelineStages?.length
      ? db.settings.pipelineStages
      : ['New', 'Qualified', 'Proposal', 'Negotiation', 'Won'])
      .map(stage => {
        const rows = deals.filter(d => String(d.stage || '').toLowerCase() === String(stage).toLowerCase() || d.stage === stage);
        return { stage, count: rows.length, value: rows.reduce((sum, d) => sum + (Number(d.value) || 0), 0) };
      });

    const funnel = LIFECYCLE_STAGES.map(stage => {
      const count = leads.filter(l => (l.lifecycleStage || 'Lead') === stage).length
        + (db.contacts || []).filter(c => (c.lifecycleStage || 'Lead') === stage).length;
      return { stage, count };
    });

    const owners = new Map();
    const openByOwner = {};
    for (const owner of team) {
      const owned = deals.filter(d => d.owner === owner.name || d.owner === owner.email || d.owner === owner.id);
      openByOwner[owner.name] = {
        owner: owner.name,
        deals: owned.filter(d => String(d.stage || '').toLowerCase() !== 'won').length,
        value: owned.reduce((sum, d) => sum + (Number(d.value) || 0), 0),
        wonValue: owned.filter(d => String(d.stage || '').toLowerCase() === 'won').reduce((sum, d) => sum + (Number(d.value) || 0), 0)
      };
      owners.set(owner.name, openByOwner[owner.name]);
    }
    for (const deal of deals) {
      if (!deal.owner) continue;
      if (!owners.has(deal.owner)) {
        openByOwner[deal.owner] = { owner: deal.owner, deals: 0, value: 0, wonValue: 0 };
        owners.set(deal.owner, openByOwner[deal.owner]);
      }
    }

    const recentActivity = [...activities]
      .sort((a, b) => (a.createdAt || a.date || '') > (b.createdAt || b.date || '') ? -1 : 1)
      .slice(0, 10)
      .map(a => ({ id: a.id, title: a.title, type: a.type, contact: a.contact, notes: a.notes, date: a.createdAt || a.date || '' }));

    const upcomingTasks = [...tasks]
      .filter(t => t.status !== 'Completed')
      .sort((a, b) => (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1)
      .slice(0, 8)
      .map(t => ({ id: t.id, title: t.title, owner: t.owner, priority: t.priority, dueDate: t.dueDate, status: t.status }));

    res.json({
      metrics: {
        pipelineValue: openDeals.reduce((sum, d) => sum + (Number(d.value) || 0), 0),
        wonRevenue: wonDeals.reduce((sum, d) => sum + (Number(d.value) || 0), 0),
        openDeals: openDeals.length,
        wonDeals: wonDeals.length,
        leadsCreated30d: leads.filter(l => l.createdAt >= days30).length,
        leadsCreated7d: leads.filter(l => l.createdAt >= days7).length,
        contactCount: (db.contacts || []).length,
        activities7d: activities.filter(a => (a.createdAt || '') >= days7).length,
        tasksDue: tasks.filter(t => t.status !== 'Completed').length
      },
      dealsByStage,
      funnel,
      topPerformers: Object.values(openByOwner).sort((a, b) => b.value - a.value).slice(0, 5),
      recentActivity,
      upcomingTasks,
      winRate: openDeals.length + wonDeals.length
        ? Math.round((wonDeals.length / (openDeals.length + wonDeals.length)) * 100)
        : 0
    });
  });
}