import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { repoFor } from '../db/repositories/index.js';
import { pgToLegacy, legacyToPg } from '../db/legacy-shape.js';
import { coerceBuiltIns, id, now } from '../helpers.js';
import { readDb, mutateDb } from '../store.js';
import { calculateGoalProgress } from '../services/goals.js';

const VALID_TYPES = new Set(['revenue', 'activity', 'deal']);
const VALID_PERIODS = new Set(['monthly', 'quarterly', 'annual']);

export default function registerGoalRoutes(app) {
  /**
   * GET /api/goals
   * List performance goals with pagination, filtering, and workspace isolation.
   */
  app.get('/api/goals', auth, async (req, res, next) => {
    try {
      const workspaceId = req.user?.workspaceId || req.user?.workspace_id || 'default';
      const repo = repoFor('goals');

      const {
        page,
        limit,
        sortBy = 'created_at:desc',
        q,
        status,
        type,
        assignedTo,
        period,
        paginated,
      } = req.query;

      const pageNum = page !== undefined ? parseInt(page, 10) || 1 : undefined;
      const limitNum = limit !== undefined ? parseInt(limit, 10) || 50 : undefined;
      const hasPaging = pageNum !== undefined || limitNum !== undefined || paginated === 'true';

      if (repo) {
        try {
          const result = await repo.findAll({
            page: pageNum || 1,
            limit: limitNum || 50,
            sortBy,
            q,
            status,
            type,
            assignedTo,
            period,
            workspaceId,
          });

          const data = (result.data || []).map((row) =>
            coerceBuiltIns('goals', pgToLegacy(row, 'goals')),
          );

          if (hasPaging) {
            return res.json({
              data,
              total: result.total,
              page: result.page,
              limit: result.limit,
              totalPages: result.totalPages,
            });
          }
          return res.json(data);
        } catch (_) {
          // If PG query fails, proceed to in-memory store fallback
        }
      }

      // In-memory fallback
      const db = await readDb();
      const records = (db.goals || []).filter((g) => {
        const itemWs = g.workspaceId || g.workspace_id || 'default';
        if (workspaceId && itemWs !== workspaceId && !(workspaceId === 'default' && !g.workspaceId)) {
          return false;
        }
        if (status && String(g.status || '').toLowerCase() !== String(status).toLowerCase()) {
          return false;
        }
        if (type && String(g.type || g.metric || '').toLowerCase() !== String(type).toLowerCase()) {
          return false;
        }
        if (assignedTo && g.assignedTo !== assignedTo && g.assigned_to !== assignedTo) {
          return false;
        }
        if (period && String(g.period || '').toLowerCase() !== String(period).toLowerCase()) {
          return false;
        }
        return true;
      });

      const total = records.length;
      if (hasPaging) {
        const p = pageNum || 1;
        const l = limitNum || 50;
        const start = (p - 1) * l;
        const paginatedData = records.slice(start, start + l);
        return res.json({
          data: paginatedData,
          total,
          page: p,
          limit: l,
          totalPages: Math.ceil(total / l) || 0,
        });
      }
      return res.json(records);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/goals
   * Create a performance goal.
   */
  app.post('/api/goals', auth, requireRole('admin', 'member'), async (req, res, next) => {
    try {
      const workspaceId = req.user?.workspaceId || req.user?.workspace_id || 'default';
      const body = req.body || {};

      if (!body.name || !String(body.name).trim()) {
        return res.status(400).json({ error: 'Goal name is required' });
      }

      const rawType = String(body.type || body.metric || 'revenue').trim().toLowerCase();
      if (!VALID_TYPES.has(rawType)) {
        return res.status(400).json({
          error: "Invalid goal type. Must be one of: 'revenue', 'activity', 'deal'",
        });
      }

      const rawPeriod = String(body.period || 'monthly').trim().toLowerCase();
      if (!VALID_PERIODS.has(rawPeriod)) {
        return res.status(400).json({
          error: "Invalid goal period. Must be one of: 'monthly', 'quarterly', 'annual'",
        });
      }

      if (body.target === undefined || body.target === null || body.target === '') {
        return res.status(400).json({ error: 'Goal target is required' });
      }
      const targetNum = Number(body.target);
      if (Number.isNaN(targetNum) || targetNum <= 0) {
        return res.status(400).json({ error: 'Target must be a valid positive number' });
      }

      const repo = repoFor('goals');
      if (repo) {
        try {
        const pgData = legacyToPg(
          {
            // `...body` comes first on purpose: the fields below are the
            // server-derived, validated ones and must win. Spreading the body
            // last let a caller-supplied `workspace_id` overwrite the tenant,
            // which is a cross-tenant write.
            ...body,
            workspace_id: workspaceId,
            name: String(body.name).trim(),
            type: rawType,
            target: targetNum,
            period: rawPeriod,
            assigned_to: body.assignedTo || body.assigned_to || null,
            assigned_type: body.assignedType || body.assigned_type || 'user',
            start_date: body.startDate || body.start_date || null,
            end_date: body.endDate || body.end_date || null,
            status: body.status || 'active',
          },
          'goals',
        );
          coerceBuiltIns('goals', pgData);
          const row = await repo.create(pgData);
          if (row) {
            const item = coerceBuiltIns('goals', pgToLegacy(row, 'goals'));
            return res.status(201).json(item);
          }
        } catch (_) {
          // Fallback to in-memory store
        }
      }

      // In-memory fallback
      const createdAt = now();
      const record = {
        id: id('goal'),
        workspaceId,
        name: String(body.name).trim(),
        type: rawType,
        target: targetNum,
        period: rawPeriod,
        assignedTo: body.assignedTo || body.assigned_to || null,
        assignedType: body.assignedType || body.assigned_type || 'user',
        startDate: body.startDate || body.start_date || null,
        endDate: body.endDate || body.end_date || null,
        status: body.status || 'active',
        createdAt,
        updatedAt: createdAt,
      };
      await mutateDb((db) => {
        if (!db.goals) db.goals = [];
        db.goals.unshift(record);
      });
      return res.status(201).json(record);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/goals/:id/progress
   * Calculate live progress metrics for a goal against real-time data.
   */
  app.get('/api/goals/:id/progress', auth, async (req, res, next) => {
    try {
      const workspaceId = req.user?.workspaceId || req.user?.workspace_id || 'default';
      const repo = repoFor('goals');
      let goal = null;

      if (repo) {
        try {
          const row = await repo.findById(req.params.id, workspaceId);
          if (row) {
            goal = coerceBuiltIns('goals', pgToLegacy(row, 'goals'));
          }
        } catch (_) {
          // ignore
        }
      }

      if (!goal) {
        const db = await readDb();
        goal = (db.goals || []).find(
          (g) => g.id === req.params.id && (g.workspaceId === workspaceId || workspaceId === 'default'),
        );
      }

      if (!goal) {
        return res.status(404).json({ error: 'Goal not found' });
      }

      const progress = await calculateGoalProgress(goal, {
        workspaceId,
        now: req.query.now ? new Date(req.query.now) : new Date(),
      });

      return res.json(progress);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/goals/:id
   * Get a goal by ID.
   */
  app.get('/api/goals/:id', auth, async (req, res, next) => {
    try {
      const workspaceId = req.user?.workspaceId || req.user?.workspace_id || 'default';
      const repo = repoFor('goals');
      let goal = null;

      if (repo) {
        try {
          const row = await repo.findById(req.params.id, workspaceId);
          if (row) {
            goal = coerceBuiltIns('goals', pgToLegacy(row, 'goals'));
          }
        } catch (_) {
          // ignore
        }
      }

      if (!goal) {
        const db = await readDb();
        goal = (db.goals || []).find(
          (g) => g.id === req.params.id && (g.workspaceId === workspaceId || workspaceId === 'default'),
        );
      }

      if (!goal) {
        return res.status(404).json({ error: 'Goal not found' });
      }

      return res.json(goal);
    } catch (err) {
      next(err);
    }
  });

  /**
   * PUT /api/goals/:id
   * Update a performance goal.
   */
  app.put('/api/goals/:id', auth, requireRole('admin', 'member'), async (req, res, next) => {
    try {
      const workspaceId = req.user?.workspaceId || req.user?.workspace_id || 'default';
      const body = req.body || {};

      if (body.type !== undefined || body.metric !== undefined) {
        const rawType = String(body.type || body.metric).trim().toLowerCase();
        if (!VALID_TYPES.has(rawType)) {
          return res.status(400).json({
            error: "Invalid goal type. Must be one of: 'revenue', 'activity', 'deal'",
          });
        }
      }

      if (body.period !== undefined) {
        const rawPeriod = String(body.period).trim().toLowerCase();
        if (!VALID_PERIODS.has(rawPeriod)) {
          return res.status(400).json({
            error: "Invalid goal period. Must be one of: 'monthly', 'quarterly', 'annual'",
          });
        }
      }

      if (body.target !== undefined && body.target !== null && body.target !== '') {
        const targetNum = Number(body.target);
        if (Number.isNaN(targetNum) || targetNum <= 0) {
          return res.status(400).json({ error: 'Target must be a valid positive number' });
        }
      }

      const repo = repoFor('goals');
      if (repo) {
        try {
          const pgData = legacyToPg(body, 'goals');
          coerceBuiltIns('goals', pgData);
          const row = await repo.update(req.params.id, pgData, workspaceId);
          if (row) {
            const item = coerceBuiltIns('goals', pgToLegacy(row, 'goals'));
            return res.json(item);
          }
        } catch (_) {
          // ignore
        }
      }

      // In-memory fallback
      let updated = null;
      await mutateDb((db) => {
        const list = db.goals || [];
        const index = list.findIndex(
          (g) => g.id === req.params.id && (g.workspaceId === workspaceId || workspaceId === 'default'),
        );
        if (index >= 0) {
          list[index] = {
            ...list[index],
            ...body,
            updatedAt: now(),
          };
          updated = list[index];
        }
      });

      if (!updated) {
        return res.status(404).json({ error: 'Goal not found' });
      }
      return res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /api/goals/:id
   * Delete a performance goal.
   */
  app.delete('/api/goals/:id', auth, requireRole('admin', 'member'), async (req, res, next) => {
    try {
      const workspaceId = req.user?.workspaceId || req.user?.workspace_id || 'default';
      const repo = repoFor('goals');
      let deleted = false;

      if (repo) {
        try {
          deleted = await repo.delete(req.params.id, workspaceId);
        } catch (_) {
          // ignore
        }
      }

      if (!deleted) {
        await mutateDb((db) => {
          const list = db.goals || [];
          const idx = list.findIndex(
            (g) => g.id === req.params.id && (g.workspaceId === workspaceId || workspaceId === 'default'),
          );
          if (idx >= 0) {
            list.splice(idx, 1);
            deleted = true;
          }
        });
      }

      if (!deleted) {
        return res.status(404).json({ error: 'Goal not found' });
      }

      return res.json({ message: 'Goal deleted successfully' });
    } catch (err) {
      next(err);
    }
  });
}
