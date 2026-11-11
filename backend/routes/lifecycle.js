import { readDb, mutateDb } from '../store.js';
import { loadRecords, findRecord, saveRecord } from '../db/legacy-records.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { auditEntry, id, now, resources } from '../helpers.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { broadcast } from './sse.js';

export const LIFECYCLE_STAGES = ['Subscriber', 'Lead', 'MQL', 'SQL', 'Opportunity', 'Customer', 'Evangelist'];
// Human-readable labels for stages whose key is an acronym. The key stays the
// value persisted in `lifecycleStage`, so LIFECYCLE_STAGES remains the single
// source of truth for ordering and validation.
const STAGE_LABELS = {
  MQL: 'Marketing Qualified Lead',
  SQL: 'Sales Qualified Lead'
};

const REQUIRED_BY_STAGE = {
  MQL: ['email'],
  SQL: ['email', 'phone'],
  Opportunity: ['email', 'company', 'value'],
  Customer: ['email', 'company', 'value']
};

function validateTransition(db, record, targetStage) {
  const index = LIFECYCLE_STAGES.indexOf(targetStage);
  const currentIndex = LIFECYCLE_STAGES.indexOf(record.lifecycleStage);
  if (targetStage && index < 0) return { ok: false, error: `Invalid lifecycle stage: ${targetStage}` };
  if (currentIndex >= 0 && index < currentIndex) {
    return { ok: false, error: `Cannot move from ${record.lifecycleStage} back to ${targetStage}` };
  }
  const required = REQUIRED_BY_STAGE[targetStage];
  if (required) {
    for (const field of required) {
      const value = record[field];
      if (value === undefined || value === null || value === '') {
        return { ok: false, error: `${field} is required before entering ${targetStage} stage` };
      }
    }
  }
  return { ok: true };
}

export default function registerLifecycleRoutes(app) {
  const lifecycleStageLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 60,
    prefix: 'lifecycle'
  });

  app.get('/api/lifecycle/stages', auth, async (req, res) => {
    const db = await readDb();
    db.contacts = await loadRecords('contacts', db);
    db.leads = await loadRecords('leads', db);
    const stages = LIFECYCLE_STAGES.map((stage, order) => {
      const records = (db.contacts || []).filter(c => (c.lifecycleStage || 'Subscriber') === stage)
        .concat((db.leads || []).filter(l => (l.lifecycleStage || 'Subscriber') === stage));
      return { key: stage, label: STAGE_LABELS[stage] || stage, order, stage, count: records.length };
    });
    res.json({ stages, requiredByStage: REQUIRED_BY_STAGE });
  });

  // Set lifecycle stage on a record (leads/contacts) with validation
  app.post('/api/lifecycle/transition', auth, requireRole('admin', 'member'), async (req, res) => {
    const { recordId, stage } = req.body || {};
    if (!recordId || !stage) return res.status(400).json({ error: 'recordId and stage are required' });
    if (!LIFECYCLE_STAGES.includes(stage)) return res.status(400).json({ error: `stage must be one of: ${LIFECYCLE_STAGES.join(', ')}` });

    const saved = await mutateDb(async db => {
      const found = await findRecord(recordId, ['leads', 'contacts'], db);
      let record = found?.record;
      if (!record) return null;
      const validation = validateTransition(db, record, stage);
      if (!validation.ok) return { error: validation.error };

      record = { ...record, lifecycleStage: stage, lifecycleUpdatedAt: now(), updatedAt: now() };
      const target = found.resource;
      record = await saveRecord(target, record, db);
      await saveRecord('activities', { title: `Lifecycle → ${stage}`, type: 'Lifecycle', contact: record.name || record.email || '', notes: `Moved to lifecycle stage ${stage}`, date: now().slice(0, 10), recordId, createdAt: now(), updatedAt: now() }, db);
      db.audit.unshift({ id: id('audit'), action: `Moved ${target.slice(0, -1)} to ${stage}`, actor: req.user.name, createdAt: now() });
      return record;
    });
    if (!saved) return res.status(404).json({ error: 'Record not found' });
    if (saved.error) return res.status(400).json({ error: saved.error });
    broadcast('lifecycle.transitioned', { recordId, stage }, req.user.workspaceId || 'default');
    res.json(saved);
  });

  // Generic lifecycle stage update. Unlike POST /api/lifecycle/transition, which is
  // lead/contact-only and enforces per-stage field requirements, this accepts any
  // known resource so deals, companies and other records can carry a stage too.
  app.patch(
    '/api/:resource/:id/lifecycle',
    auth,
    requireRole('admin', 'member'),
    lifecycleStageLimiter,
    async (req, res, next) => {
      const resource = req.params.resource;
      // `resources` is an allowlist, but it is a runtime check that static
      // analysis cannot see through: saveRecord() indexes its store with this
      // name, so a `__proto__` value would otherwise look reachable and trip
      // js/prototype-polluting-assignment. Reject the prototype key explicitly
      // (it is not in the allowlist anyway) so no user-controlled name can ever
      // reach Object.prototype.
      if (resource === '__proto__') return next();
      // Only resources the API knows about can carry a lifecycle stage. An
      // unknown segment falls through so the router answers with its normal
      // 404 instead of pretending an arbitrary collection exists.
      if (!resources.has(resource)) return next();

      const { stage } = req.body || {};
      if (!stage) return res.status(400).json({ error: 'stage is required' });
      if (!LIFECYCLE_STAGES.includes(stage)) {
        return res.status(400).json({ error: `stage must be one of: ${LIFECYCLE_STAGES.join(', ')}` });
      }

      const recordId = req.params.id;
      const actor = req.user.name;
      const outcome = await mutateDb(async db => {
        // Resolve and persist through the repository layer. Going through
        // findRecord/saveRecord keeps PostgreSQL-backed resources in their
        // canonical shape and removes the raw `db[resource]` array assignment
        // that was flagged as a prototype-polluting sink
        // (js/prototype-polluting-assignment). The allowlist above already
        // bounds `resource`; this makes the write path itself safe by
        // construction rather than by caller discipline.
        const found = await findRecord(recordId, [resource], db);
        if (!found) return { missing: true };

        const currentIndex = LIFECYCLE_STAGES.indexOf(found.record.lifecycleStage);
        if (currentIndex >= 0 && LIFECYCLE_STAGES.indexOf(stage) < currentIndex) {
          return { invalid: `Cannot move from ${found.record.lifecycleStage} back to ${stage}` };
        }

        const stamp = now();
        const record = {
          ...found.record,
          lifecycleStage: stage,
          lifecycleUpdatedAt: stamp,
          updatedAt: stamp
        };
        const saved = await saveRecord(resource, record, db);

        // Same shape as the entry POST /api/lifecycle/transition writes, so the
        // activity renders in the record timeline through the recordId link.
        await saveRecord(
          'activities',
          {
            id: id('activity'),
            title: `Lifecycle → ${stage}`,
            type: 'Lifecycle',
            contact: record.name || record.email || '',
            notes: `Lifecycle stage changed to ${stage}`,
            date: stamp.slice(0, 10),
            recordId,
            createdAt: stamp,
            updatedAt: stamp
          },
          db
        );
        db.audit.unshift(
          auditEntry({
            action: `Lifecycle stage changed to ${stage}`,
            actor,
            createdAt: stamp,
            req,
            resourceId: recordId
          })
        );
        return { record: { ...(saved || record), lifecycleUpdatedAt: stamp, updatedAt: stamp } };
      });

      if (outcome.missing) return res.status(404).json({ error: 'Record not found' });
      if (outcome.invalid) return res.status(400).json({ error: outcome.invalid });
      broadcast(
        'lifecycle.transitioned',
        { resource, recordId, stage },
        req.user.workspaceId || 'default'
      );
      res.json(outcome.record);
    }
  );

  // Bulk lifecycle transitions
  app.post('/api/lifecycle/bulk', auth, requireRole('admin', 'member'), async (req, res) => {
    const { recordIds = [], stage } = req.body || {};
    if (!stage || !LIFECYCLE_STAGES.includes(stage)) return res.status(400).json({ error: 'Valid stage is required' });
    if (!Array.isArray(recordIds) || !recordIds.length) return res.status(400).json({ error: 'recordIds array is required' });

    let moved = 0;
    let errors = [];
    await mutateDb(async db => {
      for (const recordId of recordIds) {
        const found = await findRecord(recordId, ['leads', 'contacts'], db);
        const record = found?.record;
        if (!record) { errors.push({ recordId, error: 'not found' }); continue; }
        const validation = validateTransition(db, record, stage);
        if (!validation.ok) { errors.push({ recordId, error: validation.error }); continue; }
        await saveRecord(found.resource, { ...record, lifecycleStage: stage, lifecycleUpdatedAt: now(), updatedAt: now() }, db);
        moved++;
      }
      db.audit.unshift({ id: id('audit'), action: `Bulk lifecycle → ${stage} (${moved} records)`, actor: req.user.name, createdAt: now() });
    });
    res.json({ moved, errors });
  });

  app.post('/api/lifecycle/reset', auth, requireRole('admin', 'member'), async (req, res) => {
    const { recordId } = req.body || {};
    if (!recordId) return res.status(400).json({ error: 'recordId is required' });
    const saved = await mutateDb(async db => {
      const found = await findRecord(recordId, ['leads', 'contacts'], db);
      if (!found) return null;
      return saveRecord(found.resource, { ...found.record, lifecycleStage: 'Subscriber', updatedAt: now() }, db);
    });
    if (!saved) return res.status(404).json({ error: 'Record not found' });
    res.json(saved);
  });
}
