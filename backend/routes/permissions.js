import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { id, now } from '../helpers.js';

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

/**
 * Removes keys listed in fieldPerms.hiddenFields from an inbound write payload
 * (POST/PUT) before schema validation and persistence. Enforces the same
 * field-level RBAC on writes that applyFieldMasking enforces on reads.
 *
 * Safe on null, undefined, empty, or non-object bodies — they are returned
 * unchanged (validation will reject grossly-wrong payloads as usual).
 */
export function stripHiddenFields(body, fieldPerms) {
  if (!fieldPerms || body == null) return body;
  if (Array.isArray(body)) {
    return body.map((item) => stripHiddenFields(item, fieldPerms));
  }
  if (typeof body !== 'object') return body;
  const hidden = Array.isArray(fieldPerms.hiddenFields)
    ? fieldPerms.hiddenFields
    : [];
  if (hidden.length === 0) return body;
  const out = { ...body };
  for (const field of hidden) delete out[field];
  return out;
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
