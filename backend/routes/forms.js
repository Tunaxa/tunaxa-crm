import crypto from 'node:crypto';
import { readDb, mutateDb } from '../store.js';
import { loadRecords, findRecord, saveRecord } from '../db/legacy-records.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now, coerceCustomFields } from '../helpers.js';
import { matchCondition } from '../services/conditions.js';
import { triggerWorkflows, createdEvent, updatedEvent } from '../services/workflows.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { broadcast } from './sse.js';
import { repoFor } from '../db/repositories/index.js';
import { pgToLegacy, legacyToPg } from '../db/legacy-shape.js';

const publicLimiter = createRateLimiter({ windowMs: 60_000, max: 120, prefix: 'forms' });

// Mirrors the workspace_id DEFAULT on the tables (migration 003) and the
// `req.user.workspaceId || 'default'` pattern the other PG routes use. Every
// write has to set it explicitly: the column is nullable, so an omitted value
// silently files the row under `default` instead of failing.
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

function fieldValue(payload, field) {
  if (payload[field.key] !== undefined) return payload[field.key];
  if (field.name && payload[field.name] !== undefined) return payload[field.name];
  return payload[field.label] ?? '';
}

async function findKnown(db, recordId) {
  if (!recordId) return null;
  return (await findRecord(recordId, ['leads', 'contacts'], db))?.record || null;
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

// Leads and contacts predate RESOURCE_MAPPINGS, so legacyToPg() takes the
// generic path for them: it splits `name` into first_name/last_name and leaves
// every other key as-is. The repositories then insert only their own column
// list, which means a form field that is not a lead/contact column has to be
// routed into the custom_fields bag explicitly or it is silently dropped. The
// JSON handler got this for free by spreading the record.
const LEAD_COLUMNS = new Set([
  'workspace_id', 'first_name', 'last_name', 'email', 'phone', 'company_name',
  'status', 'source', 'value', 'owner_id', 'custom_fields',
]);
const CONTACT_COLUMNS = new Set([
  'workspace_id', 'company_id', 'first_name', 'last_name', 'email', 'phone', 'title',
  'owner_id', 'custom_fields',
]);

// Bucket submitted form values into real columns and the custom_fields bag.
//
// `existing` is the matched row's current bag. A partial submission must not
// wipe fields it never carried: the JSON handler updated with
// `{ ...record, ...mapped }`, so unrelated custom fields survived. Passing the
// stored bag back in reproduces that, and real columns still win over the bag
// because they are written to their own key.
const IGNORED_KEYS = new Set(['id', 'createdAt', 'updatedAt', 'custom_fields']);

function splitRecordValues(values, resource, existing = null) {
  const columns = resource === 'contacts' ? CONTACT_COLUMNS : LEAD_COLUMNS;
  const record = {};
  const custom = { ...(existing || {}) };
  for (const [key, value] of Object.entries(values)) {
    // The database owns the id and both timestamps. genericLegacyToPg drops the
    // camelCase timestamps but passes `id` through, and either key would end up
    // in the custom_fields bag here and then be stored as if a visitor had
    // filled in a form field called "id".
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
  // ============ Public endpoints (no auth) ============

  // Render a form for embedding; progressive profiling hides fields the visitor already filled.
  app.get('/api/forms/:permalink', publicLimiter, async (req, res) => {
    const db = await readDb();
    const permalink = String(req.params.permalink || '').toLowerCase();
    const form = (db.forms || []).find(f => f.permalink === permalink && f.enabled !== false);
    if (!form) return res.status(404).json({ error: 'Form not found' });

    const known = await findKnown(db, req.query.recordId || '');
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
  });

  // Submit a form submission.
  app.post('/api/forms/:permalink/submit', publicLimiter, async (req, res) => {
    const permalink = String(req.params.permalink || '').toLowerCase();
    try {
      const found = await findForm(permalink);
      if (!found) return res.status(404).json({ error: 'Form not found' });
      const { form, workspaceId } = found;

      const payload = { ...(req.body.payload || req.body || {}) };
      const recordId = payload.recordId || '';
      const vid = payload.vid || '';
      delete payload.recordId;
      delete payload.vid;

    const known = await findKnown(db, recordId);
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
          // Normalize MultiSelect payloads from any transport shape (JSON array,
          // comma-separated string, single value) into a trimmed string array so
          // downstream custom-field coercion stays consistent.
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

    const result = await mutateDb(async db => {
      const createdAt = now();
      let record = null;
      let recordResource = target;
      let existing = false;

      if (email) {
        record = (await loadRecords(target, db)).find(x => String(x.email || '').toLowerCase() === email);
      }

      if (record) {
        existing = true;
        record = { ...record, ...coerceCustomFields(db, target, { ...mapped }), updatedAt: createdAt };
      } else {
        record = {
          id: id(target === 'leads' ? 'lead' : 'contact'),
          ...coerceCustomFields(db, target, { ...mapped }),
          source: record?.source || form.name || 'Form',
          formId: form.id,
          lifecycleStage: 'Lead',
          createdAt,
          updatedAt: createdAt
        };
      }

      record = await saveRecord(target, record, db);

      // Attribute web visits (pixel) to this record
      if (vid) {
        if (!db.webVisits) db.webVisits = [];
        const prior = db.webVisits.filter(v => v.vid === vid);
        prior.forEach(v => { v.recordId = record.id; v.attributed = true; });
        if (prior.length) {
          record.firstVisitAt = record.firstVisitAt || prior[0].createdAt || createdAt;
          record.lastVisitAt = createdAt;
          record.visitCount = (record.visitCount || 0) + prior.length;
          record.attributionSource = record.attributionSource || prior[0].page || '';
        }
        db.pendingAttribution = (db.pendingAttribution || []).filter(p => p.vid !== vid);
      }

      record = await saveRecord(target, record, db);
      await saveRecord('activities', {
        id: id('activity'),
        title: `${existing ? 'Updated via' : 'Submitted'} form: ${form.name}`,
        type: 'Form',
        contact: record.email || record.name || '',
        notes: Object.entries(mapped).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(', ').slice(0, 400),
        date: createdAt.slice(0, 10),
        recordId: record.id,
        createdAt,
        updatedAt: createdAt
      }, db);
      db.audit.unshift({ id: id('audit'), action: `${existing ? 'Updated' : 'Created'} ${target.slice(0, -1)} via form "${form.name}"`, actor: 'Public', createdAt });

      return { record, existing, id: record.id };
    });

    const event = result.existing ? updatedEvent(target) : createdEvent(target);
    if (event) triggerWorkflows(target, event, result.record);
    triggerWorkflows(target, 'form.submitted', result.record).catch(() => {});
    broadcast('record.created', { resource: target, item: result.record });
    broadcast('form.submitted', { formId: form.id, permalink, recordId: result.id });

      res.status(201).json({ ok: true, recordId: legacyRecord.id, existing, form: permalink });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============ Management endpoints (auth) ============

  app.get('/api/forms', auth, async (req, res) => {
    try {
      const repo = repoFor('forms');
      const filters = {};
      if (req.query.q) filters.q = req.query.q;
      if (req.query.enabled !== undefined && req.query.enabled !== '') {
        filters.enabled = req.query.enabled === 'true';
      }
      if (req.query.page !== undefined) filters.page = Number(req.query.page) || 1;
      if (req.query.limit !== undefined) filters.limit = Number(req.query.limit) || 20;
      const result = await repo.findAll(filters);
      res.json({
        data: result.data.map(row => pgToLegacy(row, 'forms')),
        total: result.total
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/forms', auth, requireRole('admin', 'member'), async (req, res) => {
    const body = req.body || {};
    if (!body.name || !Array.isArray(body.fields) || !body.fields.length) {
      return res.status(400).json({ error: 'name and at least one field are required' });
    }
    const permalink = String(body.permalink || slugify(body.name)).toLowerCase();
    try {
      // The unique index on permalink is the real guard; checking first only
      // turns the common case into a friendlier error than a constraint
      // violation, and this is not a substitute for the constraint.
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
        updatedAt: now()
      };
      if (!db.forms) db.forms = [];
      db.forms.unshift(form);
      db.audit.unshift({ id: id('audit'), action: `Created form "${form.name}"`, actor: req.user.name, createdAt: now() });
      return form;
    });
    if (saved.error) return res.status(400).json({ error: saved.error });
    broadcast('form.created', { id: saved.id });
    res.status(201).json(saved);
  });

  app.put('/api/forms/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const body = req.body || {};
    const saved = await mutateDb(db => {
      const form = (db.forms || []).find(f => f.id === req.params.id);
      if (!form) return null;
      Object.assign(form, body, { id: form.id });
      if (Array.isArray(body.fields)) {
        form.fields = body.fields.map(f => ({
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
      if (body.enabled !== undefined) form.enabled = body.enabled === true || body.enabled === 'true';
      form.updatedAt = now();
      return form;
    });
    if (!saved) return res.status(404).json({ error: 'Form not found' });
    broadcast('form.updated', { id: saved.id });
    res.json(saved);
  });

  app.delete('/api/forms/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const result = await mutateDb(db => {
      const index = (db.forms || []).findIndex(f => f.id === req.params.id);
      if (index < 0) return false;
      const [form] = db.forms.splice(index, 1);
      db.audit.unshift({ id: id('audit'), action: `Deleted form "${form.name}"`, actor: req.user.name, createdAt: now() });
      return true;
    });
    if (!result) return res.status(404).json({ error: 'Form not found' });
    broadcast('form.deleted', { id: req.params.id });
    res.json({ ok: true });
  });
}
