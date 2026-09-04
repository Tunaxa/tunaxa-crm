import crypto from 'node:crypto';

const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const now = () => new Date().toISOString();

export function diffFields(previous, next) {
  const changes = [];
  const keys = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
  for (const key of keys) {
    if (key === 'updatedAt' || key === 'id') continue;
    const before = JSON.stringify(previous?.[key]);
    const after = JSON.stringify(next?.[key]);
    if (before !== after) {
      changes.push({
        field: key,
        from: serialize(previous?.[key]),
        to: serialize(next?.[key])
      });
    }
  }
  return changes;
}

function serialize(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function recordRevision(db, resource, previous, next, user) {
  if (!previous || !next) return null;
  const changes = diffFields(previous, next);
  if (!changes.length) return null;
  if (!db.revisions) db.revisions = [];
  const revision = {
    id: id('rev'),
    resource,
    recordId: next.id,
    actor: user?.name || 'System',
    actorId: user?.id || '',
    changes,
    createdAt: now()
  };
  db.revisions.unshift(revision);
  if (db.revisions.length > 5000) db.revisions.length = 5000;
  return revision.id;
}

export function getRevisions(db, { resource, recordId, limit = 50 } = {}) {
  let revisions = db.revisions || [];
  if (resource) revisions = revisions.filter(r => r.resource === resource);
  if (recordId) revisions = revisions.filter(r => r.recordId === recordId);
  return revisions.slice(0, limit);
}