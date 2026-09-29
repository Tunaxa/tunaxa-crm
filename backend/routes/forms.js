import crypto from 'node:crypto';
import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now, coerceCustomFields, paginateAndSort } from '../helpers.js';
import { matchCondition } from '../services/conditions.js';
import { triggerWorkflows, createdEvent, updatedEvent } from '../services/workflows.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { broadcast } from './sse.js';

const publicLimiter = createRateLimiter({ windowMs: 60_000, max: 120, prefix: 'forms' });

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

function findKnown(db, recordId) {
  if (!recordId) return null;
  return db.leads.find(x => x.id === recordId) || db.contacts.find(x => x.id === recordId) || null;
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

export default function registerFormRoutes(app) {
  // ============ Public endpoints (no auth) ============

  // Render a form for embedding; progressive profiling hides fields the visitor already filled.
  app.get('/api/forms/:permalink', publicLimiter, async (req, res) => {
    const db = await readDb();
    const permalink = String(req.params.permalink || '').toLowerCase();
    const form = (db.forms || []).find(f => f.permalink === permalink && f.enabled !== false);
    if (!form) return res.status(404).json({ error: 'Form not found' });

    const known = findKnown(db, req.query.recordId || '');
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
    const db = await readDb();
    const form = (db.forms || []).find(f => f.permalink === permalink && f.enabled !== false);
    if (!form) return res.status(404).json({ error: 'Form not found' });

    const payload = { ...(req.body.payload || req.body || {}) };
    const recordId = payload.recordId || '';
    const vid = payload.vid || '';
    delete payload.recordId;
    delete payload.vid;

    const known = findKnown(db, recordId);
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

    const result = await mutateDb(db => {
      const createdAt = now();
      let record = null;
      let existing = false;

      if (email) {
        record = db[target].find(x => String(x.email || '').toLowerCase() === email)
          || (target === 'leads' ? db.contacts.find(x => String(x.email || '').toLowerCase() === email) : db.leads.find(x => String(x.email || '').toLowerCase() === email));
      }

      if (record) {
        existing = true;
        const index = db[target].findIndex(x => x.id === record.id);
        db[target][index] = { ...db[target][index], ...coerceCustomFields(db, target, { ...mapped }), updatedAt: createdAt };
        record = db[target][index];
      } else {
        record = {
          id: id(target === 'leads' ? 'lead' : 'contact'),
          ...coerceCustomFields(db, target, { ...mapped }),
          source: record?.source || form.name || 'Form',
          formId: form.id,
          lifecycleStage: target === 'leads' ? 'Lead' : 'Lead',
          createdAt,
          updatedAt: createdAt
        };
        db[target].unshift(record);
      }

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

      db.activities.unshift({
        id: id('activity'),
        title: `${existing ? 'Updated via' : 'Submitted'} form: ${form.name}`,
        type: 'Form',
        contact: record.email || record.name || '',
        notes: Object.entries(mapped).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(', ').slice(0, 400),
        date: createdAt.slice(0, 10),
        recordId: record.id,
        createdAt,
        updatedAt: createdAt
      });
      db.audit.unshift({ id: id('audit'), action: `${existing ? 'Updated' : 'Created'} ${target.slice(0, -1)} via form "${form.name}"`, actor: 'Public', createdAt });

      return { record, existing, id: record.id };
    });

    const event = result.existing ? updatedEvent(target) : createdEvent(target);
    if (event) triggerWorkflows(target, event, result.record);
    triggerWorkflows(target, 'form.submitted', result.record).catch(() => {});
    const workspaceId = form.workspaceId || 'default';
    broadcast('record.created', { resource: target, item: result.record }, workspaceId);
    broadcast('form.submitted', { formId: form.id, permalink, recordId: result.id }, workspaceId);

    res.status(201).json({ ok: true, recordId: result.id, existing: result.existing, form: permalink });
  });

  // ============ Management endpoints (auth) ============

  app.get('/api/forms', auth, async (req, res) => {
    const db = await readDb();
    res.json(paginateAndSort(db.forms || [], req.query));
  });

  app.post('/api/forms', auth, requireRole('admin', 'member'), async (req, res) => {
    const body = req.body || {};
    if (!body.name || !Array.isArray(body.fields) || !body.fields.length) {
      return res.status(400).json({ error: 'name and at least one field are required' });
    }
    const permalink = String(body.permalink || slugify(body.name)).toLowerCase();
    const saved = await mutateDb(db => {
      if ((db.forms || []).some(f => f.permalink === permalink)) return { error: 'A form with this permalink already exists' };
      const form = {
        id: id('form'),
        permalink,
        name: body.name,
        title: body.title || body.name,
        description: body.description || '',
        submitTo: body.submitTo === 'contact' ? 'contact' : 'lead',
        progressive: body.progressive !== false,
        redirectUrl: body.redirectUrl || '',
        fields: body.fields.map(f => ({
          id: id('fld'),
          key: f.key,
          name: f.name || f.label || f.key,
          type: f.type || 'text',
          required: Boolean(f.required),
          placeholder: f.placeholder || '',
          options: Array.isArray(f.options) ? f.options : [],
          visibleIf: f.visibleIf || null,
          progressive: f.progressive !== false
        })),
        enabled: true,
        workspaceId: req.user.workspaceId || 'default',
        submissionCount: 0,
        createdAt: now(),
        createdBy: req.user.name,
        updatedAt: now()
      };
      if (!db.forms) db.forms = [];
      db.forms.unshift(form);
      db.audit.unshift({ id: id('audit'), action: `Created form "${form.name}"`, actor: req.user.name, createdAt: now() });
      return form;
    });
    if (saved.error) return res.status(400).json({ error: saved.error });
    broadcast('form.created', { id: saved.id }, req.user.workspaceId || 'default');
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
    broadcast('form.updated', { id: saved.id }, req.user.workspaceId || 'default');
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
    broadcast('form.deleted', { id: req.params.id }, req.user.workspaceId || 'default');
    res.json({ ok: true });
  });
}