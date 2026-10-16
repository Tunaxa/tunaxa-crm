import { query } from '../db/pg.js';
import { readDb } from '../store.js';
import { pgToLegacy } from '../db/legacy-shape.js';
import { coerceBuiltIns } from '../helpers.js';

/**
 * Determine the date range [startDate, endDate] for a given goal.
 */
export function getGoalDateRange(goal, now = new Date()) {
  const currentDate = new Date(now);
  const rawStart = goal.startDate || goal.start_date;
  const rawEnd = goal.endDate || goal.end_date;

  if (rawStart && rawEnd) {
    return {
      startDate: new Date(rawStart),
      endDate: new Date(rawEnd),
    };
  }

  const period = String(goal.period || 'monthly').toLowerCase();
  const year = currentDate.getUTCFullYear();
  const month = currentDate.getUTCMonth();

  if (period === 'annual' || period === 'yearly') {
    const startDate = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
    const endDate = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
    return { startDate, endDate };
  }

  if (period === 'quarterly') {
    const quarter = Math.floor(month / 3);
    const startDate = new Date(Date.UTC(year, quarter * 3, 1, 0, 0, 0, 0));
    const endDate = new Date(Date.UTC(year, (quarter + 1) * 3, 0, 23, 59, 59, 999));
    return { startDate, endDate };
  }

  // Default: monthly
  const startDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
  return { startDate, endDate };
}

/**
 * Determine pace status given target, actual, startDate, endDate, and now.
 */
export function computeGoalStatus(target, actual, startDate, endDate, now = new Date()) {
  if (actual >= target) {
    return 'achieved';
  }

  const currentDate = new Date(now);
  const totalMs = endDate.getTime() - startDate.getTime();
  const elapsedMs = currentDate.getTime() - startDate.getTime();

  if (currentDate >= endDate) {
    return 'behind';
  }

  if (elapsedMs <= 0 || totalMs <= 0) {
    return 'on_track';
  }

  const elapsedRatio = Math.min(1, Math.max(0, elapsedMs / totalMs));
  const expectedPace = target * elapsedRatio;

  if (expectedPace <= 0 || actual >= expectedPace * 0.85) {
    return 'on_track';
  }
  if (actual >= expectedPace * 0.6) {
    return 'at_risk';
  }
  return 'behind';
}

/**
 * Calculate live progress for a performance goal against PostgreSQL deals,
 * activities, or revenue records, with in-memory JSON fallback.
 */
export async function calculateGoalProgress(goal, { workspaceId, now = new Date() } = {}) {
  const ws = workspaceId || goal.workspaceId || goal.workspace_id || 'default';
  const assigned = goal.assignedTo || goal.assigned_to || null;
  const type = String(goal.type || goal.metric || 'revenue').toLowerCase();
  const target = Number(goal.target) || 0;
  const { startDate, endDate } = getGoalDateRange(goal, now);

  let actual = 0;
  let count = 0;
  let pgSuccess = false;

  // ── 1. Try PostgreSQL Aggregation ───────────────────────────────────────
  try {
    if (type === 'revenue') {
      let sql = `
        SELECT
          COALESCE(SUM(CAST(value AS NUMERIC)), 0)::float AS actual,
          COUNT(*)::int AS count
        FROM deals
        WHERE workspace_id = $1
          AND (stage ILIKE '%Won%' OR stage ILIKE '%Closed Won%' OR (custom_fields->>'stage') ILIKE '%Won%')
          AND (
            (created_at >= $2 AND created_at <= $3)
            OR (expected_close_date >= $2 AND expected_close_date <= $3)
          )
      `;
      const params = [ws, startDate.toISOString(), endDate.toISOString()];
      if (assigned) {
        params.push(assigned);
        sql += ` AND (owner_id = $4 OR owner = $4 OR (custom_fields->>'assignedTo') = $4 OR (custom_fields->>'assigned_to') = $4)`;
      }
      const res = await query(sql, params);
      if (res && res.rows && res.rows[0]) {
        actual = Number(res.rows[0].actual) || 0;
        count = Number(res.rows[0].count) || 0;
        pgSuccess = true;
      }
    } else if (type === 'activity') {
      let sql = `
        SELECT COUNT(*)::int AS actual
        FROM activities
        WHERE workspace_id = $1
          AND (created_at >= $2 AND created_at <= $3)
      `;
      const params = [ws, startDate.toISOString(), endDate.toISOString()];
      if (assigned) {
        params.push(assigned);
        sql += ` AND (user_id = $4 OR (custom_fields->>'userId') = $4 OR (custom_fields->>'assignedTo') = $4)`;
      }
      const res = await query(sql, params);
      if (res && res.rows && res.rows[0]) {
        actual = Number(res.rows[0].actual) || 0;
        count = actual;
        pgSuccess = true;
      }
    } else if (type === 'deal') {
      let sql = `
        SELECT
          COUNT(*)::int AS actual,
          COALESCE(SUM(CAST(value AS NUMERIC)), 0)::float AS total_value
        FROM deals
        WHERE workspace_id = $1
          AND (created_at >= $2 AND created_at <= $3)
      `;
      const params = [ws, startDate.toISOString(), endDate.toISOString()];
      if (assigned) {
        params.push(assigned);
        sql += ` AND (owner_id = $4 OR owner = $4 OR (custom_fields->>'assignedTo') = $4 OR (custom_fields->>'assigned_to') = $4)`;
      }
      const res = await query(sql, params);
      if (res && res.rows && res.rows[0]) {
        actual = Number(res.rows[0].actual) || 0;
        count = actual;
        pgSuccess = true;
      }
    }
  } catch (err) {
    // If PG is unreachable or table missing in offline mode, fallback to in-memory JSON
    pgSuccess = false;
  }

  // ── 2. In-Memory Store Fallback ─────────────────────────────────────────
  if (!pgSuccess) {
    const db = await readDb();
    const startMs = startDate.getTime();
    const endMs = endDate.getTime();

    const isMatchDate = (itemDate) => {
      if (!itemDate) return false;
      const t = new Date(itemDate).getTime();
      return !isNaN(t) && t >= startMs && t <= endMs;
    };

    const isMatchWs = (item) => (item.workspaceId || item.workspace_id || 'default') === ws;

    if (type === 'revenue') {
      const deals = (db.deals || []).filter((d) => {
        if (!isMatchWs(d)) return false;
        const stage = String(d.stage || d.status || '').toLowerCase();
        if (!stage.includes('won')) return false;
        if (assigned && (d.ownerId !== assigned && d.owner !== assigned && d.assignedTo !== assigned)) {
          return false;
        }
        return isMatchDate(d.createdAt || d.created_at) || isMatchDate(d.expectedCloseDate || d.closeDate);
      });
      actual = deals.reduce((sum, d) => sum + (Number(d.value) || 0), 0);
      count = deals.length;
    } else if (type === 'activity') {
      const acts = (db.activities || []).filter((a) => {
        if (!isMatchWs(a)) return false;
        if (assigned && (a.userId !== assigned && a.user_id !== assigned && a.assignedTo !== assigned)) {
          return false;
        }
        return isMatchDate(a.createdAt || a.created_at || a.date);
      });
      actual = acts.length;
      count = acts.length;
    } else if (type === 'deal') {
      const deals = (db.deals || []).filter((d) => {
        if (!isMatchWs(d)) return false;
        if (assigned && (d.ownerId !== assigned && d.owner !== assigned && d.assignedTo !== assigned)) {
          return false;
        }
        return isMatchDate(d.createdAt || d.created_at);
      });
      actual = deals.length;
      count = deals.length;
    }
  }

  // ── 3. Calculate Pace & Percentage ──────────────────────────────────────
  const percentage = target > 0 ? Math.round((actual / target) * 100) : 0;
  const remaining = Math.max(0, target - actual);
  const status = computeGoalStatus(target, actual, startDate, endDate, now);

  const goalShape = pgToLegacy(goal, 'goals') || goal;
  coerceBuiltIns('goals', goalShape);

  return {
    goal: goalShape,
    target,
    actual,
    count,
    percentage,
    remaining,
    period: String(goal.period || 'monthly').toLowerCase(),
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    status,
  };
}
