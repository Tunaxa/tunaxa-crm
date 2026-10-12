import { readDb, mutateDb } from '../store.js';
import { findRecord } from '../db/legacy-records.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now } from '../helpers.js';
import { getSettings, isEmailConfigured } from '../services/config.js';
import { sendEmail } from '../services/smtp.js';
import { broadcast } from './sse.js';

export function renderMerge(template, record) {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = key.split('.').reduce((obj, part) => (obj && typeof obj === 'object' ? obj[part] : undefined), record);
    return value === undefined || value === null ? '' : String(value);
  });
}

function checkExitRules(record, sequence) {
  const rules = Array.isArray(sequence.exitRules) ? sequence.exitRules : [];
  for (const rule of rules) {
    if (!rule.active) continue;
    if (rule.type === 'reply' && record.replied) return { exited: true, reason: 'Contact replied' };
    if (rule.type === 'meeting' && record.meetingBooked) return { exited: true, reason: 'Meeting booked' };
    if (rule.type === 'unsubscribe' && record.unsubscribed) return { exited: true, reason: 'Contact unsubscribed' };
    if (rule.type === 'notEnrolled' && (rule.enrolledDaysAgo && record.enrolledAt)) {
      const ageDays = (Date.now() - new Date(record.enrolledAt).getTime()) / 86400000;
      if (ageDays > Number(rule.enrolledDaysAgo || 0)) return { exited: true, reason: 'Enrollment window expired' };
    }
  }
  return { exited: false };
}

export default function registerSequenceRoutes(app) {
  app.get('/api/sequences', auth, async (req, res) => {
    const db = await readDb();
    res.json({ data: db.sequences || [], total: (db.sequences || []).length });
  });

  app.post('/api/sequences', auth, requireRole('admin', 'member'), async (req, res) => {
    const { name, steps = [], exitRules = [], enabled = true } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Sequence name is required' });
    if (!Array.isArray(steps) || steps.length === 0) return res.status(400).json({ error: 'Sequence must contain at least one step' });
    const sequence = await mutateDb(db => {
      if (!db.sequences) db.sequences = [];
      const item = { id: id('sequence'), name, enabled, steps: steps.map((s, i) => ({ id: id('step'), order: i, ...s })), exitRules, enrolled: [], createdAt: now(), createdBy: req.user.name, updatedAt: now() };
      db.sequences.unshift(item);
      return item;
    });
    res.status(201).json(sequence);
  });

  app.put('/api/sequences/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const sequence = await mutateDb(db => {
      const found = (db.sequences || []).find(s => s.id === req.params.id);
      if (!found) return null;
      if (req.body.name) found.name = req.body.name;
      if (Array.isArray(req.body.steps)) found.steps = req.body.steps.map((s, i) => ({ ...s, id: s.id || id('step'), order: i }));
      if (Array.isArray(req.body.exitRules)) found.exitRules = req.body.exitRules;
      if (typeof req.body.enabled === 'boolean') found.enabled = req.body.enabled;
      found.updatedAt = now();
      return found;
    });
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
    res.json(sequence);
  });

  app.delete('/api/sequences/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const ok = await mutateDb(db => {
      const index = (db.sequences || []).findIndex(s => s.id === req.params.id);
      if (index < 0) return false;
      db.sequences.splice(index, 1);
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'Sequence not found' });
    res.json({ ok: true });
  });

  // Enroll contacts/leads into a sequence
  app.post('/api/sequences/:id/enroll', auth, requireRole('admin', 'member'), async (req, res) => {
    const { recordIds = [] } = req.body || {};
    if (!Array.isArray(recordIds) || !recordIds.length) return res.status(400).json({ error: 'recordIds array is required' });
    const result = await mutateDb(async db => {
      const seq = (db.sequences || []).find(s => s.id === req.params.id);
      if (!seq) return null;
      let enrolled = 0;
      for (const recordId of recordIds) {
        const record = (await findRecord(recordId, ['leads', 'contacts', 'companies'], db))?.record;
        if (!record) continue;
        if (seq.enrolled.some(e => e.recordId === recordId)) continue;
        seq.enrolled.unshift({ recordId, email: record.email || '', name: record.name || record.title || '', enrolledAt: now(), currentStep: 0, nextStepAt: now() });
        if (!db.activityByRecord) db.activityByRecord = {};
        enrolled++;
      }
      seq.updatedAt = now();
      db.audit.unshift({ id: id('audit'), action: `Enrolled ${enrolled} records in "${seq.name}"`, actor: req.user.name, createdAt: now() });
      return { seq, enrolled };
    });
    if (!result) return res.status(404).json({ error: 'Sequence not found' });
    broadcast('sequence.enrolled', { sequenceId: req.params.id, count: result.enrolled }, req.user.workspaceId || 'default');
    res.status(201).json(result);
  });

  // Pause/unenroll a record
  app.delete('/api/sequences/:id/enroll/:recordId', auth, requireRole('admin', 'member'), async (req, res) => {
    const result = await mutateDb(db => {
      const seq = (db.sequences || []).find(s => s.id === req.params.id);
      if (!seq) return null;
      seq.enrolled = (seq.enrolled || []).filter(e => e.recordId !== req.params.recordId);
      return { unenrolled: true };
    });
    if (!result) return res.status(404).json({ error: 'Sequence not found' });
    res.json(result);
  });

  // Advance sequence steps (run the engine manually)
  app.post('/api/sequences/:id/run', auth, requireRole('admin', 'member'), async (req, res) => {
    const settings = await getSettings();
    const summary = await mutateDb(async db => {
      const seq = (db.sequences || []).find(s => s.id === req.params.id);
      if (!seq || !seq.enabled) return null;
      let sent = 0, skipped = 0, exited = 0;
      for (const enrollment of seq.enrolled) {
        const record = (await findRecord(enrollment.recordId, ['leads', 'contacts', 'companies'], db))?.record;
        if (!record) { exited++; continue; }
        const check = checkExitRules(record, seq);
        if (check.exited) {
          db.activities.unshift({ id: id('activity'), title: `Unenrolled from "${seq.name}"`, type: 'Sequence', contact: record.name || record.email || '', notes: check.reason, date: now().slice(0, 10), createdAt: now(), updatedAt: now() });
          enrollment.unenrolledAt = now();
          enrollment.exitReason = check.reason;
          exited++;
          continue;
        }
        const step = seq.steps[enrollment.currentStep];
        if (!step) { enrollment.completedAt = now(); continue; }
        if (new Date(enrollment.nextStepAt) > new Date()) { skipped++; continue; }

        const createdAt = now();
        const message = { id: id('message'), channel: 'Email', to: renderMerge(step.to || record.email || '', record), subject: renderMerge(step.subject || '', record), body: renderMerge(step.body || '', record), contact: record.name || record.email || '', direction: 'Outbound', status: 'Queued', sequenceId: seq.id, source: 'sequence', createdAt, updatedAt: createdAt };
        db.messages.unshift(message);
        sent++;

        enrollment.nextStepAt = step.delayDays ? new Date(Date.now() + Number(step.delayDays) * 86400000).toISOString() : new Date().toISOString();
        enrollment.currentStep += 1;
        db.activities.unshift({ id: id('activity'), title: `Sequence step ${enrollment.currentStep}/${seq.steps.length} — ${seq.name}`, type: 'Sequence', contact: record.name || record.email || '', notes: `${step.subject || step.body?.slice(0, 80) || 'No subject'}`, date: createdAt.slice(0, 10), messageId: message.id, createdAt, updatedAt: createdAt });

        if (step.action === 'createTask') {
          db.tasks.unshift({ id: id('task'), title: renderMerge(step.title || 'Follow up call', record), owner: record.owner || '', priority: step.priority || 'Medium', status: 'Open', source: 'sequence', sequenceId: seq.id, createdAt, updatedAt: createdAt });
        }
        const outboundMessage = message;
        setTimeout(() => {
          if (isEmailConfigured(settings)) {
            sendEmail(settings, { to: outboundMessage.to, subject: outboundMessage.subject, text: outboundMessage.body }).then(result => {
              mutateDb(d => {
                const idx = d.messages.findIndex(m => m.id === outboundMessage.id);
                if (idx >= 0) { d.messages[idx].status = result.status || 'Failed'; if (result.providerId) d.messages[idx].providerId = result.providerId; d.messages[idx].updatedAt = now(); }
              });
            }).catch(() => {});
          }
        }, 0);
      }
      seq.updatedAt = now();
      return { sent, skipped, exited };
    });
    if (!summary) return res.status(404).json({ error: 'Sequence not found or disabled' });
    broadcast('sequence.ran', { sequenceId: req.params.id, ...summary }, req.user.workspaceId || 'default');
    res.json(summary);
  });
}
