import crypto from 'node:crypto';
import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now, coerceCustomFields } from '../helpers.js';
import { matchCondition } from '../services/conditions.js';
import { triggerWorkflows, createdEvent, updatedEvent } from '../services/workflows.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { broadcast } from './sse.js';
import { checkWriteFieldMask } from './permissions.js';
import { repoFor } from '../db/repositories/index.js';
import { pgToLegacy, legacyToPg } from '../db/legacy-shape.js';

const publicLimiter = createRateLimiter({ windowMs: 60_000, max: 120, prefix: 'forms' });

const DEFAULT_WORKSPACE = 'default';

function slugify(name) {
  const slug = String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || `form_${crypto.randomBytes(3).toString('hex')}`;
}

function filled(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

const HONEYPOT_FIELDS = new Set(['_hp', '_gotcha', 'website', 'honeypot']);
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasForbiddenKeys(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasForbiddenKeys(item)) return true;
    }
    return false;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    if (hasForbiddenKeys(value[key])) return true;
  }
  return false;
}

function applyCorsHeaders(res, origin) {
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', CORS_HEADERS['Access-Control-Allow-Methods']);
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS['Access-Control-Allow-Headers']);
  res.setHeader('Access-Control-Max-Age', CORS_HEADERS['Access-Control-Max-Age']);
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function resolveAllowedOrigins(form) {
  const candidates = Array.isArray(form?.allowedOrigins)
    ? form.allowedOrigins
    : Array.isArray(form?.settings?.allowedOrigins)
      ? form.settings.allowedOrigins
      : null;
  if (!candidates || candidates.length === 0) return null;
  const origins = [];
  for (const entry of candidates) {
    const normalized = normalizeOrigin(entry);
    if (normalized && !origins.includes(normalized)) origins.push(normalized);
  }
  return origins.length ? origins : null;
}

function resolveCorsOrigin(req, form) {
  const allowed = resolveAllowedOrigins(form);
  if (!allowed) return { ok: true, origin: null };
  const requestOrigin = normalizeOrigin(req.headers.origin);
  if (!requestOrigin || !allowed.includes(requestOrigin)) {
    return { ok: false, origin: null };
  }
  return { ok: true, origin: requestOrigin };
}

function detectHoneypot(payload) {
  for (const key of HONEYPOT_FIELDS) {
    if (filled(payload[key])) return key;
  }
  return null;
}

function stripHoneypot(payload) {
  for (const key of HONEYPOT_FIELDS) delete payload[key];
}

function validateSubmissionPayload(req) {
  const body = req.body ?? {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid request' };
  }
  if (hasForbiddenKeys(body)) {
    return { error: 'Invalid request' };
  }
  const payloadSource = Object.prototype.hasOwnProperty.call(body, 'payload') ? body.payload : body;
  if (!payloadSource || typeof payloadSource !== 'object' || Array.isArray(payloadSource)) {
    return { error: 'Invalid request' };
  }
  const keys = Object.keys(payloadSource);
  if (keys.length > 50) {
    return { error: 'Invalid request' };
  }
  for (const key of keys) {
    if (typeof key !== 'string' || key.length > 128) {
      return { error: 'Invalid request' };
    }
    const value = payloadSource[key];
    if (typeof value === 'string') {
      if (value.length > 10000) return { error: 'Invalid request' };
    } else if (Array.isArray(value)) {
      if (value.length > 100) return { error: 'Invalid request' };
      for (const item of value) {
        if (typeof item === 'string' && item.length > 10000) {
          return { error: 'Invalid request' };
        }
      }
    }
  }
  return { payload: { ...payloadSource } };
}

function fieldValue(payload, field) {
  if (payload[field.key] !== undefined) return payload[field.key];
  if (field.name && payload[field.name] !== undefined) return payload[field.name];
  return payload[field.label] ?? '';
}

async function findKnown(recordId, workspaceId) {
  if (!recordId) return null;
  const lead = await repoFor('leads').findById(recordId, workspaceId);
  if (lead) return pgToLegacy(lead, 'leads');
  const contact = await repoFor('contacts').findById(recordId, workspaceId);
  return contact ? pgToLegacy(contact, 'contacts') : null;
}

async function findForm(permalink) {
  const row = await repoFor('forms').findByPermalink(permalink);
  if (!row) return null;
  return { form: pgToLegacy(row, 'forms'), workspaceId: row.workspace_id || DEFAULT_WORKSPACE };
}

function normalizeFields(fields) {
  return fields.map(f => ({
    id: f.id || id('fld'),
    key: f.key,
    name: f.name || f.label || f.key,
    type: f.type || 'text',
    required: Boolean(f.required),
    placeholder: f.placeholder || '',
    options: Array.isArray(f.options) ? f.options : [],
    visibleIf: f.visibleIf || null,
    progressive: f.progressive !== false
  }));
}

function flattenForPublic(form) {
  return {
    permalink: form.permalink,
    name: form.name,
    title: form.title || form.name,
    description: form.description || '',
    submitTo: form.submitTo || 'lead',
    redirectUrl: form.redirectUrl || '',
    progressive: form.progressive !== false
  };
}

const LEAD_COLUMNS = new Set([
  'workspace_id', 'first_name', 'last_name', 'email', 'phone', 'company_name',
  'status', 'source', 'value', 'owner_id', 'custom_fields',
]);
const CONTACT_COLUMNS = new Set([
  'workspace_id', 'company_id', 'first_name', 'last_name', 'email', 'phone', 'title',
  'owner_id', 'custom_fields',
]);

const IGNORED_KEYS = new Set(['id', 'createdAt', 'updatedAt', 'custom_fields']);

function splitRecordValues(values, resource, existing = null) {
  const columns = resource === 'contacts' ? CONTACT_COLUMNS : LEAD_COLUMNS;
  const record = {};
  const custom = { ...(existing || {}) };
  for (const [key, value] of Object.entries(values)) {
    if (IGNORED_KEYS.has(key)) continue;
    if (key === 'name' || columns.has(key)) {
      record[key] = value;
    } else {
      custom[key] = value;
    }
  }
  if (Object.keys(custom).length) record.custom_fields = custom;
  return record;
}

export default function registerFormRoutes(app) {

  app.get('/api/forms/:permalink', publicLimiter, async (req, res) => {
    try {
      const found = await findForm(String(req.params.permalink || '').toLowerCase());
      if (!found) return res.status(404).json({ error: 'Form not found' });
      const { form, workspaceId } = found;

      const known = await findKnown(req.query.recordId || '', workspaceId);
      const fields = (form.fields || [])
        .filter(f => {
          if (form.progressive !== false && f.progressive !== false && known && filled(known[f.key])) {
            return false;
          }
          return true;
        })
        .map(f => ({
          id: f.id || f.key,
          key: f.key,
          label: f.name || f.label || f.key,
          type: f.type || 'text',
          required: Boolean(f.required),
          placeholder: f.placeholder || '',
          options: Array.isArray(f.options) ? f.options : (f.options ? String(f.options).split(',').map(x => x.trim()).filter(Boolean) : []),
          visibleIf: f.visibleIf || null
        }));
      res.json({ form: { ...flattenForPublic(form), fields } });
    } catch (error) {
      console.error('[forms] Request failed', error?.message || error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.options('/api/forms/:permalink/submit', publicLimiter, async (req, res) => {
    const permalink = String(req.params.permalink || '').toLowerCase();
    try {
      const found = await findForm(permalink);
      if (!found) {
        applyCorsHeaders(res, null);
        return res.status(404).json({ error: 'Form not found' });
      }
      const cors = resolveCorsOrigin(req, found.form);
      if (!cors.ok) {
        return res.status(403).json({ error: 'Origin not allowed' });
      }
      applyCorsHeaders(res, cors.origin);
      return res.sendStatus(204);
    } catch (error) {
      console.error('[forms] Preflight failed', error?.message || error);
      applyCorsHeaders(res, null);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/forms/:permalink/submit', publicLimiter, async (req, res) => {
    const permalink = String(req.params.permalink || '').toLowerCase();
    try {
      const found = await findForm(permalink);
      if (!found) {
        applyCorsHeaders(res, null);
        return res.status(404).json({ error: 'Form not found' });
      }
      const { form, workspaceId } = found;
      const cors = resolveCorsOrigin(req, form);
      if (!cors.ok) {
        return res.status(403).json({ error: 'Origin not allowed' });
      }
      applyCorsHeaders(res, cors.origin);

      const rawBody = req.body ?? {};
      if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody) || hasForbiddenKeys(rawBody)) {
        return res.status(400).json({ error: 'Invalid request' });
      }
      const rawPayload = Object.prototype.hasOwnProperty.call(rawBody, 'payload') ? rawBody.payload : rawBody;
      if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload) || hasForbiddenKeys(rawPayload)) {
        return res.status(400).json({ error: 'Invalid request' });
      }

      const botField = detectHoneypot(rawPayload);
      if (botField) {
        console.warn(`[forms] Honeypot submission dropped for form ${permalink}`);
        return res.status(200).json({ success: true, message: 'Submission received' });
      }
      const strippedPayload = { ...rawPayload };
      stripHoneypot(strippedPayload);

      const validated = validateSubmissionPayload({ body: { payload: strippedPayload } });
      if (validated.error) {
        return res.status(400).json({ error: validated.error });
      }
      const payload = validated.payload;

      const recordId = payload.recordId || '';
      const vid = payload.vid || '';
      delete payload.recordId;
      delete payload.vid;

      const known = await findKnown(recordId, workspaceId);
      const fields = (form.fields || []).filter(f => {
        if (form.progressive !== false && f.progressive !== false && known && filled(known[f.key])) return false;
        const c = f.visibleIf;
        if (!c || !c.field) return true;
        return matchCondition(payload, c);
      });

      const missing = fields.filter(f => f.required && !filled(fieldValue(payload, f)));
      if (missing.length) {
        return res.status(400).json({ error: 'Missing required fields', fields: missing.map(f => f.key) });
      }

      const mapped = {};
      for (const f of form.fields || []) {
        const value = fieldValue(payload, f);
        if (f.type === 'MultiSelect') {
          if (Array.isArray(value)) {
            mapped[f.key] = value.map(v => String(v ?? '').trim()).filter(Boolean);
          } else if (filled(value)) {
            mapped[f.key] = String(value).split(',').map(v => v.trim()).filter(Boolean);
          } else if (f.required) {
            mapped[f.key] = [];
          }
        } else if (filled(value)) {
          mapped[f.key] = value;
        }
      }

      const target = form.submitTo === 'contact' ? 'contacts' : 'leads';
      const email = String(payload.email || '').toLowerCase();

      const db = await readDb();
      const values = coerceCustomFields(db, target, { ...mapped });
      const repo = repoFor(target);

      let record = null;
      let recordResource = target;
      let existing = false;

      if (email) {
        const other = target === 'leads' ? 'contacts' : 'leads';
        const inTarget = await repo.findByEmail(email, workspaceId);
        if (inTarget) {
          record = inTarget;
        } else {
          const inOther = await repoFor(other).findByEmail(email, workspaceId);
          if (inOther) {
            record = inOther;
            recordResource = other;
          }
        }
        if (record) {
          existing = true;
          record = await repoFor(recordResource).update(
            record.id,
            legacyToPg(
              splitRecordValues(values, recordResource, record.custom_fields),
              recordResource
            )
          );
        }
      }

      if (!record) {
        const createdAt = now();
        record = await repo.create(legacyToPg(splitRecordValues({
          ...values,
          workspace_id: workspaceId,
          source: form.name || 'Form',
          formId: form.id,
          lifecycleStage: 'Lead',
          createdAt,
          updatedAt: createdAt
        }, target), target));
      }

      const legacyRecord = pgToLegacy(record, recordResource);

      if (vid) {
        const visits = await mutateDb(store => {
          if (!store.webVisits) store.webVisits = [];
          const prior = store.webVisits.filter(v => v.vid === vid);
          prior.forEach(v => { v.recordId = legacyRecord.id; v.attributed = true; });
          store.pendingAttribution = (store.pendingAttribution || []).filter(p => p.vid !== vid);
          return prior;
        });
        if (visits.length) {
          const attribution = {
            ...record.custom_fields,
            firstVisitAt: legacyRecord.firstVisitAt || visits[visits.length - 1].createdAt,
            lastVisitAt: now(),
            visitCount: Number(legacyRecord.visitCount || 0) + visits.length,
            attributionSource: visits[0].page || legacyRecord.attributionSource || '',
          };
          await repoFor(recordResource).update(record.id, { custom_fields: attribution });
        }
      }

      const createdAt = now();
      try {
        await repoFor('activities').create(legacyToPg({
          title: `${existing ? 'Updated via' : 'Submitted'} form: ${form.name}`,
          type: 'Form',
          workspace_id: workspaceId,
          contact: legacyRecord.email || legacyRecord.name || '',
          notes: Object.entries(mapped).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(', ').slice(0, 400),
          date: createdAt.slice(0, 10),
          recordId: legacyRecord.id,
          createdAt,
          updatedAt: createdAt
        }, 'activities'));
      } catch (error) {
        console.error('[forms] Failed to persist submission activity', error.message);
      }

      try {
        await repoFor('forms').incrementSubmissions(form.id);
      } catch (error) {
        console.error('[forms] Failed to increment submission count', error.message);
      }

      await mutateDb(store => {
        store.audit.unshift({ id: id('audit'), action: `${existing ? 'Updated' : 'Created'} ${target.slice(0, -1)} via form "${form.name}"`, actor: 'Public', createdAt });
      });

      const event = existing ? updatedEvent(target) : createdEvent(target);
      if (event) triggerWorkflows(target, event, legacyRecord);
      triggerWorkflows(target, 'form.submitted', legacyRecord).catch(() => {});
      broadcast('record.created', { resource: target, item: legacyRecord });
      broadcast('form.submitted', { formId: form.id, permalink, recordId: legacyRecord.id });

      res.status(201).json({ ok: true, recordId: legacyRecord.id, existing, form: permalink });
    } catch (error) {
      console.error('[forms] Submission failed', error?.message || error);
      if (!res.headersSent) {
        applyCorsHeaders(res, null);
      }
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/forms', auth, async (req, res) => {
    const workspaceId = req.user?.workspaceId || req.user?.workspace_id || DEFAULT_WORKSPACE;
    try {
      const repo = repoFor('forms');
      const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 25));
      const sortDir = String(req.query.sortDir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
      const sortBy = String(req.query.sortBy || 'createdAt');
      const sortColumn = sortBy === 'createdAt' ? 'created_at' : sortBy === 'updatedAt' ? 'updated_at' : sortBy;
      const filters = { workspaceId, page, limit, sortBy: `${sortColumn}:${sortDir}` };
      if (req.query.q) filters.q = req.query.q;
      if (req.query.enabled !== undefined && req.query.enabled !== '') {
        filters.enabled = req.query.enabled === 'true';
      }
      const result = await repo.findAll(filters);
      res.json({
        data: result.data.map(row => pgToLegacy(row, 'forms')),
        total: result.total,
        page,
        limit,
      });
    } catch (error) {
      console.error('[forms] Request failed', error?.message || error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/forms', auth, requireRole('admin', 'member'), checkWriteFieldMask('form'), async (req, res) => {
    const body = req.body || {};
    if (!body.name || !Array.isArray(body.fields) || !body.fields.length) {
      return res.status(400).json({ error: 'name and at least one field are required' });
    }
    const permalink = String(body.permalink || slugify(body.name)).toLowerCase();
    try {
      if (await repoFor('forms').findByPermalink(permalink)) {
        return res.status(400).json({ error: 'A form with this permalink already exists' });
      }
      const createdAt = now();
      const row = await repoFor('forms').create(legacyToPg({
        workspace_id: req.user.workspaceId || DEFAULT_WORKSPACE,
        permalink,
        name: body.name,
        title: body.title || body.name,
        description: body.description || '',
        submitTo: body.submitTo === 'contact' ? 'contact' : 'lead',
        progressive: body.progressive !== false,
        redirectUrl: body.redirectUrl || '',
        fields: normalizeFields(body.fields),
        enabled: true,
        workspaceId: req.user.workspaceId || 'default',
        submissionCount: 0,
        createdBy: req.user.name,
        createdAt,
        updatedAt: createdAt
      }, 'forms'));
      const form = pgToLegacy(row, 'forms');
      await mutateDb(db => {
        db.audit.unshift({ id: id('audit'), action: `Created form "${form.name}"`, actor: req.user.name, createdAt });
      });
      broadcast('form.created', { id: form.id });
      res.status(201).json(form);
    } catch (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: 'A form with this permalink already exists' });
      }
      console.error('[forms] Request failed', error?.message || error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.put('/api/forms/:id', auth, requireRole('admin', 'member'), checkWriteFieldMask('form'), async (req, res) => {
    const body = req.body || {};
    const workspaceId = req.user?.workspaceId || req.user?.workspace_id || 'default';
    try {
      const patch = { ...body };
      if (Array.isArray(body.fields)) patch.fields = normalizeFields(body.fields);
      if (body.enabled !== undefined) patch.enabled = body.enabled === true || body.enabled === 'true';
      delete patch.id;
      delete patch.createdAt;
      delete patch.updatedAt;
      delete patch.workspace_id;
      delete patch.workspaceId;
      const row = await repoFor('forms').update(req.params.id, legacyToPg(patch, 'forms'), workspaceId);
      if (!row) return res.status(404).json({ error: 'Form not found' });
      const form = pgToLegacy(row, 'forms');
      await mutateDb(db => {
        db.audit.unshift({ id: id('audit'), action: `Updated form "${form.name}"`, actor: req.user.name, createdAt: now() });
      });
      broadcast('form.updated', { id: form.id });
      res.json(form);
    } catch (error) {
      console.error('[forms] Request failed', error?.message || error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.delete('/api/forms/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const workspaceId = req.user?.workspaceId || req.user?.workspace_id || 'default';
    try {
      const repo = repoFor('forms');
      const existing = await repo.findById(req.params.id, workspaceId);
      if (!existing) return res.status(404).json({ error: 'Form not found' });
      const ok = await repo.delete(req.params.id, workspaceId);
      if (!ok) return res.status(404).json({ error: 'Form not found' });
      await mutateDb(db => {
        db.audit.unshift({ id: id('audit'), action: `Deleted form "${pgToLegacy(existing, 'forms').name}"`, actor: req.user.name, createdAt: now() });
      });
      broadcast('form.deleted', { id: req.params.id });
      res.json({ ok: true });
    } catch (error) {
      console.error('[forms] Request failed', error?.message || error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
