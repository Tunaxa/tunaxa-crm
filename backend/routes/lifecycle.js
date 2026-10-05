import { readDb, mutateDb } from '../store.js';
import { loadRecords, findRecord, saveRecord } from '../db/legacy-records.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now } from '../helpers.js';
import { broadcast } from './sse.js';

export const LIFECYCLE_STAGES = ['Subscriber', 'Lead', 'MQL', 'SQL', 'Opportunity', 'Customer', 'Evangelist'];
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
  app.get('/api/lifecycle/stages', auth, async (req, res) => {
    const db = await readDb();
    db.contacts = await loadRecords('contacts', db);
    db.leads = await loadRecords('leads', db);
    const stages = LIFECYCLE_STAGES.map(stage => {
      const records = (db.contacts || []).filter(c => (c.lifecycleStage || 'Subscriber') === stage)
        .concat((db.leads || []).filter(l => (l.lifecycleStage || 'Subscriber') === stage));
      return { stage, count: records.length };
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
