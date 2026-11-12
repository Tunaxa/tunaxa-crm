import { repoFor } from "./repositories/index.js";
import { legacyToPg, pgToLegacy } from "./legacy-shape.js";

// Specialty routes still keep settings and audit records in JSON, but CRM
// records must come from the same repositories as the generic CRUD routes.
// Preserve unmigrated JSON records for backwards compatibility; PG wins by id.
export async function loadRecords(resource, db) {
  const repo = repoFor(resource);
  const rows = new Map((db[resource] || []).map(row => [row.id, row]));
  if (repo) {
    for (let page = 1; ; page++) {
      const result = await repo.findAll({ page, limit: 100 });
      for (const row of result.data) rows.set(row.id, pgToLegacy(row, resource));
      if (!result.data.length || page * 100 >= result.total) break;
    }
  }
  return [...rows.values()];
}

export async function findRecord(recordId, resources, db) {
  for (const resource of resources) {
    const repo = repoFor(resource);
    const row = repo && await repo.findById(recordId);
    const record = row ? pgToLegacy(row, resource) : (db[resource] || []).find(item => item.id === recordId);
    if (record) return { resource, record };
  }
  return null;
}

export async function saveRecord(resource, record, db) {
  const repo = repoFor(resource);
  const jsonIndex = (db[resource] || []).findIndex(row => row.id === record.id);
  const stored = repo && record.id && await repo.findById(record.id);
  // Existing unmigrated JSON records retain their ids and references.
  if (!stored && jsonIndex >= 0) {
    db[resource][jsonIndex] = record;
    return record;
  }
  if (repo) {
    const data = legacyToPg(record, resource);
    const row = stored ? await repo.update(record.id, data) : await repo.create(data);
    return pgToLegacy(row, resource);
  }
  (db[resource] ||= []).unshift(record);
  return record;
}
