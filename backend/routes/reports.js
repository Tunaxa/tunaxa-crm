import { readDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { cacheGet, cacheSet } from '../services/cache.js';
import { runReportQuery, ReportQueryError, normalizeReportSchedule, isScheduleActive } from '../services/reports.js';
import {
  listSavedReports,
  findSavedReport,
  createSavedReport,
  updateSavedReport,
  deleteSavedReport,
} from '../services/savedReports.js';
import { runScheduledReports, generateReportData } from '../workers/reportScheduler.js';

const workspaceOf = (user) => user?.workspaceId || user?.workspace_id || 'default';

/**
 * Validates and strips the aggregation definition a saved report carries.
 * Returns null when valid, or an error message to answer 400 with.
 */
function validateReportQuery(body = {}) {
  const definition = body.query && typeof body.query === 'object' ? body.query : body;
  if (!definition.entity || !String(definition.entity).trim()) {
    return 'query.entity is required';
  }
  if (!definition.groupBy || !String(definition.groupBy).trim()) {
    return 'query.groupBy is required';
  }
  if (!definition.metric || !String(definition.metric).trim()) {
    return 'query.metric is required';
  }
  return null;
}

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

  app.post(
    '/api/reports/query',
    auth,
    requireRole('admin', 'member'),
    async (req, res, next) => {
      try {
        const { entity, groupBy, metric, field, dateRange, dateField } = req.body || {};

        if (!entity || typeof entity !== 'string' || !entity.trim()) {
          return res.status(400).json({ error: 'entity is required' });
        }
        if (!groupBy || typeof groupBy !== 'string' || !groupBy.trim()) {
          return res.status(400).json({ error: 'groupBy is required' });
        }
        if (!metric || typeof metric !== 'string' || !metric.trim()) {
          return res.status(400).json({ error: 'metric is required' });
        }

        const workspaceId = req.user?.workspaceId || req.user?.workspace_id || 'default';
        const data = await runReportQuery({
          entity: entity.trim(),
          groupBy: groupBy.trim(),
          metric: metric.trim(),
          field: typeof field === 'string' ? field.trim() : field,
          dateRange,
          dateField: typeof dateField === 'string' ? dateField.trim() : dateField,
          workspaceId,
        });

        res.json(data);
      } catch (err) {
        if (err.isValidationError || err.status === 400 || err.statusCode === 400) {
          return res.status(400).json({ error: err.message });
        }
        next(err);
      }
    }
  );

  /**
   * GET /api/reports
   * List saved report definitions for the caller's workspace.
   */
  app.get('/api/reports', auth, async (req, res, next) => {
    try {
      const workspaceId = workspaceOf(req.user);
      const reports = await listSavedReports({ workspaceId });
      res.json(reports);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/reports
   * Create a saved report, optionally with a weekly email schedule attached.
   */
  app.post(
    '/api/reports',
    auth,
    requireRole('admin', 'member'),
    async (req, res, next) => {
      try {
        const workspaceId = workspaceOf(req.user);
        const body = req.body || {};

        if (!body.name || !String(body.name).trim()) {
          return res.status(400).json({ error: 'Report name is required' });
        }

        const queryError = validateReportQuery(body);
        if (queryError) {
          return res.status(400).json({ error: queryError });
        }

        const definition = body.query && typeof body.query === 'object' ? body.query : body;
        const { schedule, error } = normalizeReportSchedule(body.schedule || {}, {});
        if (error) {
          return res.status(400).json({ error });
        }

        const report = await createSavedReport(
          {
            name: String(body.name).trim(),
            description: body.description || '',
            entity: definition.entity,
            query: definition,
            schedule,
          },
          workspaceId,
        );

        res.status(201).json(report);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/reports/:id
   */
  app.get('/api/reports/:id', auth, async (req, res, next) => {
    try {
      const workspaceId = workspaceOf(req.user);
      const report = await findSavedReport(req.params.id, workspaceId);
      if (!report) return res.status(404).json({ error: 'Report not found' });
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  /**
   * PUT /api/reports/:id
   * Update a saved report definition, including its schedule when supplied.
   */
  app.put(
    '/api/reports/:id',
    auth,
    requireRole('admin', 'member'),
    async (req, res, next) => {
      try {
        const workspaceId = workspaceOf(req.user);
        const body = req.body || {};
        const existing = await findSavedReport(req.params.id, workspaceId);
        if (!existing) return res.status(404).json({ error: 'Report not found' });

        if (body.query !== undefined || body.entity !== undefined) {
          const queryError = validateReportQuery({ query: body.query || existing.query });
          if (queryError) return res.status(400).json({ error: queryError });
        }

        const patch = {};
        if (body.name !== undefined) {
          if (!String(body.name).trim()) {
            return res.status(400).json({ error: 'Report name is required' });
          }
          patch.name = String(body.name).trim();
        }
        if (body.description !== undefined) patch.description = body.description;
        if (body.entity !== undefined) patch.entity = body.entity;
        if (body.query !== undefined) patch.query = body.query;

        if (body.schedule !== undefined) {
          const { schedule, error } = normalizeReportSchedule(body.schedule, existing.schedule);
          if (error) return res.status(400).json({ error });
          patch.schedule = schedule;
          patch.scheduleEnabled = isScheduleActive(schedule);
        }

        const updated = await updateSavedReport(req.params.id, patch, workspaceId);
        if (!updated) return res.status(404).json({ error: 'Report not found' });
        res.json(updated);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * DELETE /api/reports/:id
   */
  app.delete(
    '/api/reports/:id',
    auth,
    requireRole('admin', 'member'),
    async (req, res, next) => {
      try {
        const workspaceId = workspaceOf(req.user);
        const deleted = await deleteSavedReport(req.params.id, workspaceId);
        if (!deleted) return res.status(404).json({ error: 'Report not found' });
        res.json({ message: 'Report deleted successfully' });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PUT /api/reports/:id/schedule  (POST accepted as an alias)
   * Configure or toggle the weekly email schedule for a saved report.
   */
  const setReportSchedule = async (req, res, next) => {
    try {
      const workspaceId = workspaceOf(req.user);
      const existing = await findSavedReport(req.params.id, workspaceId);
      if (!existing) return res.status(404).json({ error: 'Report not found' });

      const { schedule, error } = normalizeReportSchedule(
        req.body?.schedule && typeof req.body.schedule === 'object' ? req.body.schedule : req.body || {},
        existing.schedule,
      );
      if (error) return res.status(400).json({ error });

      const updated = await updateSavedReport(
        req.params.id,
        { schedule, scheduleEnabled: isScheduleActive(schedule) },
        workspaceId,
      );
      if (!updated) return res.status(404).json({ error: 'Report not found' });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  };

  app.put('/api/reports/:id/schedule', auth, requireRole('admin', 'member'), setReportSchedule);
  app.post('/api/reports/:id/schedule', auth, requireRole('admin', 'member'), setReportSchedule);

  /**
   * GET /api/reports/:id/schedule
   * Read back the stored schedule so a client can render the delivery form.
   */
  app.get('/api/reports/:id/schedule', auth, async (req, res, next) => {
    try {
      const workspaceId = workspaceOf(req.user);
      const report = await findSavedReport(req.params.id, workspaceId);
      if (!report) return res.status(404).json({ error: 'Report not found' });
      res.json({ reportId: report.id, schedule: report.schedule || null, active: isScheduleActive(report.schedule) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/reports/:id/send-now
   * Generate the report and email it to the configured recipients immediately,
   * bypassing the weekly cron gate.
   */
  app.post(
    '/api/reports/:id/send-now',
    auth,
    requireRole('admin', 'member'),
    async (req, res, next) => {
      try {
        const workspaceId = workspaceOf(req.user);
        const report = await findSavedReport(req.params.id, workspaceId);
        if (!report) return res.status(404).json({ error: 'Report not found' });
        if (!isScheduleActive(report.schedule)) {
          return res.status(400).json({
            error: 'Report has no active email schedule. Configure recipients first.',
          });
        }

        const result = await runScheduledReports({
          workspaceId,
          reportId: report.id,
          force: true,
        });

        const refreshed = await findSavedReport(report.id, workspaceId);
        res.json({
          reportId: report.id,
          name: report.name,
          recipients: report.schedule.recipients,
          emailsSent: result.emailsSent,
          emailsDelivered: result.emailsDelivered,
          errors: result.errors,
          lastSentAt: refreshed?.schedule?.lastSentAt || null,
          message: `Report emailed to ${result.emailsSent} recipient${result.emailsSent === 1 ? '' : 's'}`,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/reports/:id/run
   * Execute the aggregation without emailing anyone.
   */
  app.post('/api/reports/:id/run', auth, requireRole('admin', 'member'), async (req, res, next) => {
    try {
      const workspaceId = workspaceOf(req.user);
      const report = await findSavedReport(req.params.id, workspaceId);
      if (!report) return res.status(404).json({ error: 'Report not found' });
      const rows = await generateReportData(report);
      res.json({ reportId: report.id, data: rows });
    } catch (err) {
      if (err.isValidationError || err.status === 400 || err.statusCode === 400) {
        return res.status(400).json({ error: err.message });
      }
      next(err);
    }
  });
}
