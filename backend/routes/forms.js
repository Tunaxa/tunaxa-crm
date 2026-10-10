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

// CORS for the public embed surface. A third-party site renders these forms, so
// the browser must get a preflight answer before a cross-origin JSON submission
// is attempted and response headers that let the page's script read the result.
// The origin guard already exempts this path in middleware/csrf.js; these
// headers only tell the browser the exchange is legal. `*` is acceptable here
// because the endpoint is anonymous by design and never carries a session.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

function applyCorsHeaders(res) {
  for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);
}

// Honeypot anti-bot defense. These inputs are hidden from human visitors with
// CSS, but indiscriminate spam bots scrape every input on the page and fill
// them all. A non-empty value in any of these names is a bot tell; the handler
// drops the submission before any lookups, validation or writes run.
const HONEYPOT_FIELDS = new Set(['_hp', '_gotcha', 'website', 'honeypot']);

function detectHoneypot(payload) {
  for (const key of HONEYPOT_FIELDS) {
    if (filled(payload[key])) return key;
  }
  return null;
}

function stripHoneypot(payload) {
  for (const key of HONEYPOT_FIELDS) delete payload[key];
}

function fieldValue(payload, field) {
  if (payload[field.key] !== undefined) return payload[field.key];
  if (field.name && payload[field.name] !== undefined) return payload[field.name];
  return payload[field.label] ?? '';
}

// Leads and contacts moved to Postgres in migration 004, so progressive
// profiling has to read the record from the repository. Reading db.leads here
// would consult the (now empty) JSON store and treat every visitor as unknown,
// which would show fields the visitor has already filled in.
//
// `workspaceId` is mandatory: the recordId arrives in an anonymous request body,
// so without the filter a visitor holding a UUID from another workspace would
// have that lead read (to learn which fields are filled) and then overwritten by
// submitting the form.
async function findKnown(recordId, workspaceId) {
  if (!recordId) return null;
  const lead = await repoFor('leads').findById(recordId, workspaceId);
  if (lead) return pgToLegacy(lead, 'leads');
  const contact = await repoFor('contacts').findById(recordId, workspaceId);
  return contact ? pgToLegacy(contact, 'contacts') : null;
}

// The public render/submit endpoints key off `permalink`, and a disabled form
// has to be invisible to both, so the enabled check lives in the query.
//
// The raw row is returned alongside the legacy view because workspace_id is a
// `hidden` mapping column: pgToLegacy strips it, but a public submission has no
// req.user to read the workspace from and must write the lead/contact it creates
// into the *form's* workspace.
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
      res.status(500).json({ error: error.message });
    }
  });

  // CORS preflight for the public embed surface. A browser asks whether a
  // cross-origin POST is legal before attempting it (required once the payload
  // is JSON rather than a simple form body). Answered with 204 and the
  // embeddable headers; the origin guard treats OPTIONS as a safe method.
  app.options('/api/forms/:permalink/submit', (req, res) => {
    applyCorsHeaders(res);
    res.sendStatus(204);
  });

  // Submit a form submission.
  app.post('/api/forms/:permalink/submit', publicLimiter, async (req, res) => {
    const permalink = String(req.params.permalink || '').toLowerCase();
    // Every answer to this public endpoint is readable by the embedding page,
    // success, validation error or honeypot drop alike.
    applyCorsHeaders(res);
    try {
      const found = await findForm(permalink);
      if (!found) return res.status(404).json({ error: 'Form not found' });
      const { form, workspaceId } = found;

      const payload = { ...(req.body.payload || req.body || {}) };

      // Honeypot bot detection runs before validation and before any read or
      // write: a recognised non-empty honeypot value means the submitter filled
      // in a field no human could see, so the submission is dropped with a
      // convincing success so the bot does not change its payload strategy.
      const botField = detectHoneypot(payload);
      if (botField) {
        console.warn(`[FormHardening] Bot submission dropped via honeypot for form ${permalink}`);
        return res.status(200).json({ success: true, message: 'Submission received' });
      }
      // A "clean" payload must not carry the honeypot keys into custom_fields.
      stripHoneypot(payload);

      const recordId = payload.recordId || '';
      const vid = payload.vid || '';
      delete payload.recordId;
      delete payload.vid;

      // Scoped to the form's workspace: an anonymous caller supplies recordId, so
      // an unscoped lookup would let one tenant's visitor overwrite another's lead.
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

      // The record and the activity are PG rows, but webVisits, pendingAttribution
      // and audit are still JSON, so the custom-field definitions those helpers
      // need come from the JSON store while the record itself is written to PG.
      const db = await readDb();
      const values = coerceCustomFields(db, target, { ...mapped });
      const repo = repoFor(target);

      let record = null;
      let recordResource = target;
      let existing = false;

      if (email) {
        // Cross-collection fallback kept from the JSON handler: a form pointing at
        // leads still updates the matching contact when no lead matches, and vice
        // versa. The winning collection is remembered because the update has to
        // go back to the same table the match came from.
        //
        // Both lookups are scoped to the form's workspace. An address is not
        // unique across tenants, so an unscoped match would let a form in one
        // workspace overwrite the same-email person in another.
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
          // Merge the stored bag so a partial submission keeps the custom fields
          // it did not carry, the way the JSON `{ ...record, ...mapped }` did.
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
        // The submitter is anonymous, so the form's own workspace is the only
        // tenant the new record can belong to.
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

      // Attribute web visits (pixel) to this record
      if (vid) {
        await mutateDb(store => {
          if (!store.webVisits) store.webVisits = [];
          const prior = store.webVisits.filter(v => v.vid === vid);
          prior.forEach(v => { v.recordId = legacyRecord.id; v.attributed = true; });
          store.pendingAttribution = (store.pendingAttribution || []).filter(p => p.vid !== vid);
        });
      }

      // Log the submission as an activity. Activities are a PG resource, so this
      // cannot go through mutateDb any more.
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
        // The lead/contact is already committed; losing the timeline entry must
        // not fail a visitor's submission.
        console.error('[forms] Failed to persist submission activity', error.message);
      }

      // A submission is not an edit of the form definition, so the counter is
      // bumped without touching updated_at (see migration 008).
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
      res.status(500).json({ error: error.message });
    }
  });

  // ============ Management endpoints (auth) ============

  app.get('/api/forms', auth, async (req, res) => {
    const workspaceId = req.user?.workspaceId || req.user?.workspace_id || DEFAULT_WORKSPACE;
    try {
      const repo = repoFor('forms');
      const filters = { workspaceId };
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

  app.post('/api/forms', auth, requireRole('admin', 'member'), checkWriteFieldMask('form'), async (req, res) => {
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
      // 23505 is the permalink unique index. Two concurrent creates can both
      // pass the check above, so the constraint is what actually guarantees
      // uniqueness and its violation has to be reported as the same 400.
      if (error.code === '23505') {
        return res.status(400).json({ error: 'A form with this permalink already exists' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/forms/:id', auth, requireRole('admin', 'member'), checkWriteFieldMask('form'), async (req, res) => {
    const body = req.body || {};
    const workspaceId = req.user?.workspaceId || req.user?.workspace_id || 'default';
    try {
      const patch = { ...body };
      if (Array.isArray(body.fields)) patch.fields = normalizeFields(body.fields);
      if (body.enabled !== undefined) patch.enabled = body.enabled === true || body.enabled === 'true';
      // Never let a client restamp these; the database owns them.
      delete patch.id;
      delete patch.createdAt;
      delete patch.updatedAt;
      // The tenant is server-derived too, or a PUT could move a form into
      // another workspace.
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
      res.status(500).json({ error: error.message });
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
      res.status(500).json({ error: error.message });
    }
  });
}
