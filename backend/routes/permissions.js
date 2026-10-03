import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireAdmin, ADMIN_ROLES } from '../middleware/rbac.js';
import { id, now, SERVER_OWNED_FIELDS } from '../helpers.js';

const DEFAULT_PERMISSIONS = {
  contact: { admin: ['read', 'write', 'delete'], member: ['read', 'write', 'delete'], viewer: ['read'] },
  company: { admin: ['read', 'write', 'delete'], member: ['read', 'write', 'delete'], viewer: ['read'] },
  deal: { admin: ['read', 'write', 'delete'], member: ['read', 'write'], viewer: ['read'] },
  lead: { admin: ['read', 'write', 'delete'], member: ['read', 'write', 'delete'], viewer: ['read'] },
  task: { admin: ['read', 'write', 'delete'], member: ['read', 'write', 'delete'], viewer: ['read'] },
  activity: { admin: ['read', 'write', 'delete'], member: ['read', 'write'], viewer: ['read'] }
};

export async function getObjectPermissions(objectType, userRole) {
  const db = await readDb();
  const perms = db.objectPermissions || DEFAULT_PERMISSIONS;
  const typePerms = perms[objectType] || perms['contact'];
  return typePerms[userRole] || typePerms['viewer'] || ['read'];
}

export function requireObjectPermission(action) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const objectType = req.params.type || req.body?.object_type;
    if (!objectType) return next();
    const perms = await getObjectPermissions(objectType, req.user.role);
    if (!perms.includes(action)) return res.status(403).json({ error: `No ${action} permission on ${objectType}` });
    next();
  };
}

export function getFieldPermissions(db, objectType, userRole) {
  const fieldPerms = db.fieldPermissions || {};
  const typePerms = fieldPerms[objectType] || {};
  const rolePerms = typePerms[userRole];
  if (!rolePerms) return null;
  return {
    visibleFields: Array.isArray(rolePerms.visible) ? rolePerms.visible : null,
    hiddenFields: Array.isArray(rolePerms.hidden) ? rolePerms.hidden : []
  };
}

export function applyFieldMasking(record, fieldPerms) {
  if (!fieldPerms || !record || typeof record !== 'object') return record;
  const out = { ...record };
  if (Array.isArray(fieldPerms.hiddenFields)) {
    for (const field of fieldPerms.hiddenFields) out[field] = '••••••';
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Write-side field masking
// ═══════════════════════════════════════════════════════════════════════════
//
// Read masking and write masking are two halves of one control, and only the
// read half existed. `applyFieldMasking` replaces a restricted value with
// bullets on the way out, which tells a client the field exists but does nothing
// to stop it writing one: `PATCH /api/contacts/:id { phone }` reached the
// repository untouched, so a masked field was write-only-blind rather than
// write-protected. The functions below close that.
//
// Two separate things in this codebase are called "hidden", and conflating them
// would be a bug in both directions:
//
//   1. `RESOURCE_MAPPINGS[resource].hidden` (db/legacy-shape.js) is a *schema*
//      fact: `workspace_id`, `custom_fields` and `metadata` are stored but never
//      serialized. Clients legitimately send a `customFields` bag on every
//      write, so turning that list into 403s would reject almost every request.
//      It is not consulted here.
//   2. `db.fieldPermissions[objectType][role].hidden` is the *RBAC* list an
//      administrator configured. That is what forbids a write.

/**
 * Canonical spelling of a field name for comparison.
 *
 * A masked field can be configured in one spelling and arrive in another:
 * `firstName` in the UI, `first_name` from a script, `internalNotes` inside a
 * `customFields` bag. Comparing raw strings would let a client step around a
 * mask just by changing case or underscores, so both sides are folded to
 * snake_case before they are compared.
 */
export function normalizeFieldKey(key) {
  return String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

// The container keys that hold an overflow bag of custom fields rather than a
// single value. `partialDelta()` lifts these to the top level, `legacyToPg()`
// folds unknown keys back into `custom_fields`, and `pgToLegacy()` flattens the
// stored bag back out - so a masked *custom* field arrives under its bare name
// as often as it arrives nested, and both have to be inspected.
const CUSTOM_FIELD_BAGS = new Set(['customfields', 'custom_fields']);

/**
 * The masked fields for a role on an object type, normalized for comparison.
 *
 * Returns an empty set when the role has no field-permission entry at all,
 * which is the common case: masking is opt-in per object type and role.
 */
export function maskedFieldsForRole(fieldPerms) {
  const hidden = fieldPerms?.hiddenFields;
  if (!Array.isArray(hidden)) return new Set();
  return new Set(hidden.map(normalizeFieldKey).filter(Boolean));
}

/**
 * Every field name a payload would write, containers expanded.
 *
 * Key presence is what matters, not the value: `null`, `0`, `false` and `""`
 * are all writes, and a client that cannot set a masked field to null can still
 * clear it out of a merged record.
 */
export function submittedFieldKeys(data) {
  const keys = new Set();
  if (!data || typeof data !== 'object' || Array.isArray(data)) return keys;
  for (const [key, value] of Object.entries(data)) {
    const normalized = normalizeFieldKey(key);
    if (!normalized) continue;
    if (CUSTOM_FIELD_BAGS.has(normalized)) {
      // A bag is a container. Its contents are checked individually so masking
      // one custom field does not block every other one.
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [nested, nestedValue] of Object.entries(value)) {
          if (nestedValue === undefined) continue;
          keys.add(normalizeFieldKey(nested));
        }
      }
      continue;
    }
    if (value === undefined) continue;
    keys.add(normalized);
  }
  return keys;
}

/**
 * Reject a write that touches a masked field.
 *
 * Pure with respect to the store: pass `fieldPerms` (as routes/resources.js
 * already computes per request) to avoid a second read. Admins bypass the check
 * outright, matching `requireRole`, which treats Owner/owner as admin too.
 *
 * Returns the offending fields rather than responding, so the rule is testable
 * without Express and reusable from a dedicated route handler.
 *
 * @returns {Promise<{allowed: boolean, maskedFields: string[], objectType: string|null}>}
 */
export async function validateWriteFieldPermissions({
  user,
  resource,
  data,
  action = 'update',
  fieldPerms,
  db,
} = {}) {
  const objectType = objectTypeOf(resource);
  const result = { allowed: true, maskedFields: [], objectType, action };

  if (!user || !objectType) return result;
  if (ADMIN_ROLES.includes(user.role)) return result;

  const perms = fieldPerms !== undefined
    ? fieldPerms
    : getFieldPermissions(db || (await readDb()), objectType, user.role);
  const masked = maskedFieldsForRole(perms);
  if (masked.size === 0) return result;

  const submitted = submittedFieldKeys(data);
  if (submitted.size === 0) return result;

  const violations = [];
  for (const key of submitted) {
    // Server-owned fields are never a client's to write: `partialDelta()` drops
    // them, `legacyToPg()` drops the timestamps, and the tenant is derived from
    // the session. Forbidding them here would claim an authorization boundary
    // that does not exist and break payloads that already work.
    if (SERVER_OWNED_FIELDS.has(key)) continue;
    if (!masked.has(key)) continue;
    // Report the spelling the administrator configured, which is the authority,
    // rather than whatever the client happened to send.
    const canonical = (perms.hiddenFields || []).find(
      (field) => normalizeFieldKey(field) === key,
    );
    violations.push(canonical || key);
  }

  if (violations.length === 0) return result;
  result.allowed = false;
  result.maskedFields = [...new Set(violations)].sort();
  return result;
}

/**
 * Express middleware enforcing {@link validateWriteFieldPermissions}.
 *
 * Attached ahead of `validate(ResourceSchema)` on purpose: a schema rejection
 * would otherwise answer 400 first and the masked write would look like a
 * malformed request instead of a denied one.
 *
 * @param {string} [resource] override the object type; by default it is taken
 *   from the route (`req.params.type` for /api/v1/objects, `req.params.resource`
 *   singularized for /api/:resource).
 * @param {(req: object) => any} [pick] which part of the request carries the
 *   field values. Defaults to the body; a route that nests them elsewhere (a
 *   merge's `fieldOverrides`) names that sub-object so the check does not
 *   silently pass over it by inspecting the wrapper instead.
 */
export function checkWriteFieldMask(resource, pick = (req) => req.body) {
  return async (req, res, next) => {
    const objectType = resource || objectTypeOf(req.params.type || req.params.resource);
    if (!objectType || !req.user) return next();

    try {
      const payload = pick(req);
      const payloads = Array.isArray(payload) ? payload : [payload];
      const violations = new Set();

      for (const payload of payloads) {
        const check = await validateWriteFieldPermissions({
          user: req.user,
          resource: objectType,
          data: payload,
          // resources.js resolves the permission row once per request on the
          // /api/:resource middleware; reuse it rather than re-reading the store.
          fieldPerms: req.fieldPerms,
          action: req.method,
        });
        for (const field of check.maskedFields) violations.add(field);
      }

      if (!violations.size) return next();

      return res.status(403).json({
        error: 'Forbidden: Cannot write to masked field(s)',
        maskedFields: [...violations].sort(),
      });
    } catch {
      // A masking check that cannot run must fail closed. Letting it fall
      // through would turn a store error into an unmasked write.
      return res.status(500).json({ error: 'Unable to verify field permissions' });
    }
  };
}

/**
 * The `db.fieldPermissions` key for a resource segment.
 *
 * The permission model is keyed by singular object type (`contact`, `deal`)
 * while `/api/:resource` spells it plural in the URL, so the trailing `s` is
 * dropped. `resources.js` resolves its read-side permission row through this
 * same helper: if the two sides disagreed about the key, a field could be
 * masked on read and writable on write, which is the exact hole this closes.
 */
export function objectTypeOf(resource) {
  if (!resource) return null;
  const raw = String(resource);
  if (!raw) return null;
  return raw.endsWith('s') ? raw.slice(0, -1) : raw;
}

export default function registerPermissionsRoutes(app) {
  app.get('/api/permissions', auth, async (req, res) => {
    const db = await readDb();
    res.json(db.objectPermissions || DEFAULT_PERMISSIONS);
  });

  app.put('/api/permissions', auth, requireAdmin, async (req, res) => {
    const saved = await mutateDb(db => {
      db.objectPermissions = { ...DEFAULT_PERMISSIONS, ...db.objectPermissions, ...req.body };
      db.audit.unshift({ id: id('audit'), action: 'Updated object permissions', actor: req.user.name, createdAt: now() });
      return db.objectPermissions;
    });
    res.json(saved);
  });

  app.put('/api/permissions/:objectType', auth, requireAdmin, async (req, res) => {
    const { objectType } = req.params;
    const perms = req.body;
    if (!perms.admin || !perms.member || !perms.viewer) return res.status(400).json({ error: 'Must provide admin, member, and viewer arrays' });
    const saved = await mutateDb(db => {
      if (!db.objectPermissions) db.objectPermissions = { ...DEFAULT_PERMISSIONS };
      db.objectPermissions[objectType] = perms;
      db.audit.unshift({ id: id('audit'), action: `Updated permissions for ${objectType}`, actor: req.user.name, createdAt: now() });
      return db.objectPermissions[objectType];
    });
    res.json(saved);
  });

  // ============ Field-level permissions ============
  app.get('/api/permissions/fields', auth, async (req, res) => {
    const db = await readDb();
    res.json(db.fieldPermissions || {});
  });

  app.put('/api/permissions/fields/:objectType', auth, requireAdmin, async (req, res) => {
    const { objectType } = req.params;
    const { role, visible, hidden } = req.body || {};
    if (!role || (!Array.isArray(visible) && !Array.isArray(hidden))) {
      return res.status(400).json({ error: 'role and visible/hidden arrays required' });
    }
    const saved = await mutateDb(db => {
      if (!db.fieldPermissions) db.fieldPermissions = {};
      if (!db.fieldPermissions[objectType]) db.fieldPermissions[objectType] = {};
      db.fieldPermissions[objectType][role] = { visible: visible || [], hidden: hidden || [] };
      db.audit.unshift({ id: id('audit'), action: `Updated field-level permissions for ${objectType}.${role}`, actor: req.user.name, createdAt: now() });
      return db.fieldPermissions[objectType][role];
    });
    res.json(saved);
  });

  app.get('/api/permissions/fields/keys', auth, async (req, res) => {
    const db = await readDb();
    const fields = {};
    for (const resource of ['leads', 'contacts', 'companies', 'deals', 'tasks']) {
      const rows = db[resource] || [];
      const keys = new Set();
      for (const row of rows) Object.keys(row || {}).forEach(k => keys.add(k));
      fields[resource] = ['id', ...keys].filter(k => !['createdAt', 'updatedAt'].includes(k));
    }
    res.json(fields);
  });
}
