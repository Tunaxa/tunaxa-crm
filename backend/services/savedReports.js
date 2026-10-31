import { readDb, mutateDb } from '../store.js';
import { repoFor } from '../db/repositories/index.js';
import { pgToLegacy, legacyToPg } from '../db/legacy-shape.js';
import { id, now } from '../helpers.js';

const COLLECTION = 'savedReports';

/**
 * Saved report definitions live in Postgres (migrations/011_saved_reports.sql)
 * once that migration has been applied, and in the JSON store before that - and
 * whenever Postgres is unreachable. Both readers here are therefore best
 * effort: the Postgres branch is wrapped so a missing table or a refused
 * connection simply leaves the JSON store to answer, exactly as routes/goals.js
 * does.
 */

function toLegacy(row) {
  const report = pgToLegacy(row, 'savedReports') || {};
  return {
    ...report,
    workspaceId: row.workspace_id || 'default',
  };
}

async function readJsonStore() {
  try {
    const db = await readDb();
    return Array.isArray(db[COLLECTION]) ? db[COLLECTION] : [];
  } catch {
    return [];
  }
}

function matchesWorkspace(record, workspaceId) {
  if (!workspaceId) return true;
  const itemWs = record.workspaceId || record.workspace_id || 'default';
  return itemWs === workspaceId;
}

/**
 * Lists saved reports, merging the Postgres and JSON-store copies of a report
 * that exists in both (Postgres wins) so a report saved before a migration, or
 * while Postgres was down, still reaches the scheduler.
 *
 * @param {object} [options]
 * @param {string} [options.workspaceId] - Tenant scope
 * @param {boolean} [options.scheduledOnly=false] - Only reports with an enabled schedule
 * @returns {Promise<Array<object>>}
 */
export async function listSavedReports({ workspaceId, scheduledOnly = false } = {}) {
  const byId = new Map();

  try {
    const repo = repoFor('savedReports');
    if (repo && typeof repo.findAll === 'function') {
      const result = await repo.findAll({ page: 1, limit: 100, workspaceId });
      for (const row of result?.data || []) {
        const report = toLegacy(row);
        byId.set(report.id, report);
      }
    }
  } catch {
    // Missing table / no server: the JSON store below is authoritative.
  }

  for (const record of await readJsonStore()) {
    if (record.id && byId.has(record.id)) continue;
    byId.set(record.id, { ...record, workspaceId: record.workspaceId || record.workspace_id || 'default' });
  }

  let reports = [...byId.values()].filter((report) => matchesWorkspace(report, workspaceId));
  if (scheduledOnly) {
    reports = reports.filter((report) => report.schedule?.enabled === true);
  }
  return reports;
}

/**
 * Finds one saved report by id.
 *
 * @param {string} reportId
 * @param {string} [workspaceId]
 * @returns {Promise<object|null>}
 */
export async function findSavedReport(reportId, workspaceId) {
  try {
    const repo = repoFor('savedReports');
    if (repo && typeof repo.findById === 'function') {
      const row = await repo.findById(reportId, workspaceId);
      if (row) return toLegacy(row);
    }
  } catch {
    // fall through to the JSON store
  }

  const records = await readJsonStore();
  const match = records.find(
    (record) => record.id === reportId && matchesWorkspace(record, workspaceId),
  );
  return match ? { ...match, workspaceId: match.workspaceId || match.workspace_id || 'default' } : null;
}

/**
 * Creates a saved report.
 *
 * @param {object} data - Legacy-shaped report fields
 * @param {string} [workspaceId='default']
 * @returns {Promise<object>}
 */
export async function createSavedReport(data = {}, workspaceId = 'default') {
  const record = {
    ...data,
    // The explicit scope argument wins over anything in `data`. Honouring
    // `data.workspaceId` first would let a caller that forwards a request body
    // into `data` choose its own tenant.
    workspaceId: workspaceId || data.workspaceId || 'default',
  };

  try {
    const repo = repoFor('savedReports');
    if (repo && typeof repo.create === 'function') {
      const row = await repo.create(legacyToPg(record, 'savedReports'));
      if (row) return toLegacy(row);
    }
  } catch {
    // fall through to the JSON store
  }

  const created = {
    ...record,
    id: record.id || id('rpt'),
    createdAt: now(),
    updatedAt: now(),
  };
  await mutateDb((db) => {
    if (!Array.isArray(db[COLLECTION])) db[COLLECTION] = [];
    db[COLLECTION].unshift(created);
  });
  return created;
}

/**
 * Partially updates a saved report, returning null when it does not exist in
 * either backend.
 *
 * @param {string} reportId
 * @param {object} patch - Legacy-shaped fields to merge
 * @param {string} [workspaceId]
 * @returns {Promise<object|null>}
 */
export async function updateSavedReport(reportId, patch = {}, workspaceId) {
  const existing = await findSavedReport(reportId, workspaceId);
  if (!existing) return null;

  try {
    const repo = repoFor('savedReports');
    if (repo && typeof repo.update === 'function') {
      const row = await repo.update(reportId, legacyToPg(patch, 'savedReports'), workspaceId);
      if (row) return toLegacy(row);
    }
  } catch {
    // fall through to the JSON store
  }

  let updated = null;
  await mutateDb((db) => {
    const list = Array.isArray(db[COLLECTION]) ? db[COLLECTION] : [];
    const index = list.findIndex(
      (record) => record.id === reportId && matchesWorkspace(record, workspaceId),
    );
    if (index < 0) return;
    list[index] = { ...list[index], ...patch, updatedAt: now() };
    updated = list[index];
  });
  return updated ? { ...updated, workspaceId: updated.workspaceId || updated.workspace_id || 'default' } : null;
}

/**
 * Deletes a saved report from whichever backend holds it.
 *
 * @param {string} reportId
 * @param {string} [workspaceId]
 * @returns {Promise<boolean>}
 */
export async function deleteSavedReport(reportId, workspaceId) {
  try {
    const repo = repoFor('savedReports');
    if (repo && typeof repo.delete === 'function') {
      const deleted = await repo.delete(reportId, workspaceId);
      if (deleted) return true;
    }
  } catch {
    // fall through to the JSON store
  }

  let deleted = false;
  await mutateDb((db) => {
    const list = Array.isArray(db[COLLECTION]) ? db[COLLECTION] : [];
    const index = list.findIndex(
      (record) => record.id === reportId && matchesWorkspace(record, workspaceId),
    );
    if (index >= 0) {
      list.splice(index, 1);
      deleted = true;
    }
  });
  return deleted;
}
