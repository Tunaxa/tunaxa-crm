import { z } from 'zod';
import { readDb, mutateDb } from '../store.js';
import { findRecord } from '../db/legacy-records.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now, paginateAndSort } from '../helpers.js';
import { getSettings, isEmailConfigured } from '../services/config.js';
import { sendEmail } from '../services/smtp.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { broadcast } from './sse.js';
import { checkWriteFieldMask } from './permissions.js';
import {
  enrollContacts,
  listEnrollments,
  pauseEnrollment,
  resumeEnrollment,
  stopEnrollment,
  SequenceEnrollmentError,
} from '../services/sequences.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const enrollmentLimiter = createRateLimiter({ windowMs: 60_000, max: 200, prefix: 'sequence-enrollment' });
const STATUSES = ['active', 'paused', 'completed', 'replied', 'stopped'];

const idParamSchema = z.object({ id: z.string().trim().min(1).max(128) }).strict();
const enrollmentIdParamSchema = z.object({ enrollmentId: z.string().trim().min(1).max(128) }).strict();
const emptyBodySchema = z.object({}).strict();
const enrollBodySchema = z.object({
  contactIds: z.array(z.string().trim().min(1).max(128)).min(1).max(100).optional(),
  recordIds: z.array(z.string().trim().min(1).max(128)).min(1).max(100).optional(),
}).strict().refine(
  (value) => Boolean(value.contactIds) !== Boolean(value.recordIds),
  { message: 'Provide contactIds or recordIds' },
);
const listQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

function tenantOf(req) {
  return req.user?.workspaceId || req.user?.workspace_id || 'default';
}

function hasForbiddenKeys(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasForbiddenKeys);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || hasForbiddenKeys(value[key])) return true;
  }
  return false;
}

function parseOrReject(schema, value, res) {
  if (hasForbiddenKeys(value)) {
    res.status(400).json({ error: 'Invalid request' });
    return null;
  }
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return null;
  }
  return parsed.data;
}

function dedupe(values) {
  const output = [];
  for (const value of values) {
    if (!output.includes(value)) output.push(value);
  }
  return output;
}

function workspaceMatches(record, workspaceId) {
  if (!record || typeof record !== 'object') return false;
  const actual = record.workspaceId ?? record.workspace_id;
  if (actual === undefined || actual === null || actual === '') return String(workspaceId) === 'default';
  return String(actual) === String(workspaceId);
}

function findOwnedSequence(db, sequenceId, workspaceId) {
  return (db.sequences || []).find(
    (item) => String(item.id) === String(sequenceId) && workspaceMatches(item, workspaceId),
  ) || null;
}

function handleEnrollmentError(error, res) {
  if (error instanceof SequenceEnrollmentError) {
    if (error.status >= 500) {
      console.error('[sequences] enrollment failure:', error?.message || error);
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  console.error('[sequences] unexpected enrollment failure:', error?.message || error);
  return res.status(500).json({ error: 'Internal server error' });
}

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
    const scope = tenantOf(req);
    const db = await readDb();
    const sequences = (db.sequences || []).filter((item) => workspaceMatches(item, scope));
    res.json(paginateAndSort(sequences, req.query));
  });

  app.get('/api/sequences/:id', auth, async (req, res) => {
    const params = parseOrReject(idParamSchema, req.params, res);
    if (!params) return;
    const db = await readDb();
    const sequence = findOwnedSequence(db, params.id, tenantOf(req));
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
    res.json(sequence);
  });

  app.post('/api/sequences', auth, requireRole('admin', 'member'), checkWriteFieldMask('sequence'), async (req, res) => {
    const { name, steps = [], exitRules = [], enabled = true } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Sequence name is required' });
    if (!Array.isArray(steps) || steps.length === 0) return res.status(400).json({ error: 'Sequence must contain at least one step' });
    const sequence = await mutateDb(db => {
      if (!db.sequences) db.sequences = [];
      const item = { id: id('sequence'), name, enabled, workspaceId: tenantOf(req), steps: steps.map((s, i) => ({ id: id('step'), order: i, ...s })), exitRules, enrolled: [], createdAt: now(), createdBy: req.user.name, updatedAt: now() };
      db.sequences.unshift(item);
      db.audit.unshift({ id: id('audit'), action: `Created sequence "${name}"`, actor: req.user.name, createdAt: now() });
      return item;
    });
    res.status(201).json(sequence);
  });

  app.put('/api/sequences/:id', auth, requireRole('admin', 'member'), checkWriteFieldMask('sequence'), async (req, res) => {
    const params = parseOrReject(idParamSchema, req.params, res);
    if (!params) return;
    const scope = tenantOf(req);
    const sequence = await mutateDb(db => {
      const found = findOwnedSequence(db, params.id, scope);
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

  app.delete('/api/sequences/:id', enrollmentLimiter, auth, requireRole('admin', 'member'), checkWriteFieldMask('sequence'), async (req, res) => {
    const params = parseOrReject(idParamSchema, req.params, res);
    if (!params) return;
    const scope = tenantOf(req);
    const ok = await mutateDb(db => {
      const index = (db.sequences || []).findIndex(item => String(item.id) === params.id && workspaceMatches(item, scope));
      if (index < 0) return false;
      db.sequences.splice(index, 1);
      db.audit.unshift({ id: id('audit'), action: `Deleted sequence ${params.id}`, actor: req.user.name, createdAt: now() });
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'Sequence not found' });
    res.json({ ok: true });
  });

  app.get('/api/sequences/:id/enrollments', auth, async (req, res) => {
    const params = parseOrReject(idParamSchema, req.params, res);
    if (!params) return;
    const query = parseOrReject(listQuerySchema, req.query, res);
    if (!query) return;
    try {
      const result = await listEnrollments({
        sequenceId: params.id,
        workspaceId: tenantOf(req),
        status: query.status,
        page: query.page,
        pageSize: query.limit,
      });
      return res.json(result);
    } catch (error) {
      return handleEnrollmentError(error, res);
    }
  });

  app.post('/api/sequences/enrollments/:enrollmentId/pause', enrollmentLimiter, auth, requireRole('admin', 'member'), checkWriteFieldMask('sequence'), async (req, res) => {
    const params = parseOrReject(enrollmentIdParamSchema, req.params, res);
    if (!params) return;
    if (!parseOrReject(emptyBodySchema, req.body ?? {}, res)) return;
    try {
      const enrollment = await pauseEnrollment({
        enrollmentId: params.enrollmentId,
        workspaceId: tenantOf(req),
        userId: req.user.id || req.user.name,
      });
      broadcast('sequence.enrollment', { enrollmentId: enrollment.id, status: enrollment.status }, tenantOf(req));
      return res.json({ enrollment });
    } catch (error) {
      return handleEnrollmentError(error, res);
    }
  });

  app.post('/api/sequences/enrollments/:enrollmentId/resume', enrollmentLimiter, auth, requireRole('admin', 'member'), checkWriteFieldMask('sequence'), async (req, res) => {
    const params = parseOrReject(enrollmentIdParamSchema, req.params, res);
    if (!params) return;
    if (!parseOrReject(emptyBodySchema, req.body ?? {}, res)) return;
    try {
      const enrollment = await resumeEnrollment({
        enrollmentId: params.enrollmentId,
        workspaceId: tenantOf(req),
        userId: req.user.id || req.user.name,
      });
      broadcast('sequence.enrollment', { enrollmentId: enrollment.id, status: enrollment.status }, tenantOf(req));
      return res.json({ enrollment });
    } catch (error) {
      return handleEnrollmentError(error, res);
    }
  });

  app.post('/api/sequences/enrollments/:enrollmentId/stop', enrollmentLimiter, auth, requireRole('admin', 'member'), checkWriteFieldMask('sequence'), async (req, res) => {
    const params = parseOrReject(enrollmentIdParamSchema, req.params, res);
    if (!params) return;
    if (!parseOrReject(emptyBodySchema, req.body ?? {}, res)) return;
    try {
      const enrollment = await stopEnrollment({
        enrollmentId: params.enrollmentId,
        workspaceId: tenantOf(req),
        userId: req.user.id || req.user.name,
      });
      broadcast('sequence.enrollment', { enrollmentId: enrollment.id, status: enrollment.status }, tenantOf(req));
      return res.json({ enrollment });
    } catch (error) {
      return handleEnrollmentError(error, res);
    }
  });

  app.post('/api/sequences/:id/enroll', enrollmentLimiter, auth, requireRole('admin', 'member'), checkWriteFieldMask('sequence'), async (req, res) => {
    const params = parseOrReject(idParamSchema, req.params, res);
    if (!params) return;
    const body = parseOrReject(enrollBodySchema, req.body ?? {}, res);
    if (!body) return;
    const scope = tenantOf(req);

    if (body.contactIds) {
      const contactIds = dedupe(body.contactIds);
      if (!contactIds.length || contactIds.length > 100) return res.status(400).json({ error: 'Invalid request' });
      try {
        const result = await enrollContacts({
          sequenceId: params.id,
          contactIds,
          workspaceId: scope,
          userId: req.user.id || req.user.name,
        });
        broadcast('sequence.enrolled', { sequenceId: params.id, ...result }, scope);
        return res.status(201).json(result);
      } catch (error) {
        return handleEnrollmentError(error, res);
      }
    }

    const recordIds = dedupe(body.recordIds);
    if (!recordIds.length || recordIds.length > 100) return res.status(400).json({ error: 'Invalid request' });
    const result = await mutateDb(async db => {
      const seq = findOwnedSequence(db, params.id, scope);
      if (!seq) return null;
      let enrolled = 0;
      for (const recordId of recordIds) {
        const record = (await findRecord(recordId, ['leads', 'contacts', 'companies'], db))?.record;
        if (!record || !workspaceMatches(record, scope)) continue;
        if ((seq.enrolled || []).some(entry => entry.recordId === recordId)) continue;
        seq.enrolled = Array.isArray(seq.enrolled) ? seq.enrolled : [];
        seq.enrolled.unshift({ recordId, email: record.email || '', name: record.name || record.title || '', enrolledAt: now(), currentStep: 0, nextStepAt: now() });
        enrolled++;
      }
      seq.updatedAt = now();
      db.audit = Array.isArray(db.audit) ? db.audit : [];
      db.audit.unshift({ id: id('audit'), action: `Enrolled ${enrolled} records in "${seq.name}"`, actor: req.user.name, createdAt: now() });
      return { seq, enrolled };
    });
    if (!result) return res.status(404).json({ error: 'Sequence not found' });
    broadcast('sequence.enrolled', { sequenceId: params.id, count: result.enrolled }, scope);
    res.status(201).json(result);
  });

  app.delete('/api/sequences/:id/enroll/:recordId', enrollmentLimiter, auth, requireRole('admin', 'member'), checkWriteFieldMask('sequence'), async (req, res) => {
    const params = parseOrReject(z.object({ id: z.string().trim().min(1).max(128), recordId: z.string().trim().min(1).max(128) }).strict(), req.params, res);
    if (!params) return;
    const scope = tenantOf(req);
    const result = await mutateDb(db => {
      const seq = findOwnedSequence(db, params.id, scope);
      if (!seq) return null;
      seq.enrolled = (seq.enrolled || []).filter(entry => entry.recordId !== params.recordId);
      return { unenrolled: true };
    });
    if (!result) return res.status(404).json({ error: 'Sequence not found' });
    broadcast('sequence.unenrolled', { sequenceId: params.id, recordId: params.recordId }, scope);
    res.json(result);
  });

  app.post('/api/sequences/:id/run', enrollmentLimiter, auth, requireRole('admin', 'member'), checkWriteFieldMask('sequence'), async (req, res) => {
    const params = parseOrReject(idParamSchema, req.params, res);
    if (!params) return;
    const scope = tenantOf(req);
    const settings = await getSettings();
    const summary = await mutateDb(async db => {
      const seq = findOwnedSequence(db, params.id, scope);
      if (!seq || !seq.enabled) return null;
      let sent = 0, skipped = 0, exited = 0;
      for (const enrollment of seq.enrolled || []) {
        const record = (await findRecord(enrollment.recordId, ['leads', 'contacts', 'companies'], db))?.record;
        if (!record || !workspaceMatches(record, scope)) { exited++; continue; }
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
    broadcast('sequence.ran', { sequenceId: params.id, ...summary }, scope);
    res.json(summary);
  });
}
