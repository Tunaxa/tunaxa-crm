// Persistent user preference contract (P2-BE1-04).
//
// Preferences are stored inline on the authenticated user record in the JSON
// store (`backend/store.js`). That is the same source of truth
// `middleware/auth.js` reads to populate `req.user`, so a saved preference
// survives a server restart and follows the user across browsers and devices
// without a second, divergent copy in Postgres. The Postgres migration
// `011_user_preferences.sql` exists for the relational deployment path; see the
// route for how the two relate.
//
// This module is deliberately pure: it owns the vocabulary, defaults, validation
// and the deep-merge used by `routes/userPreferences.js`, so the contract is
// unit-testable without Express or the filesystem.

export const PREFERENCE_THEMES = ['light', 'dark', 'system'];
export const PREFERENCE_DENSITIES = ['compact', 'comfortable', 'spacious'];

// Guardrail: a preference payload is written back onto the user record, so cap
// its serialized size and the dimensions of `columnVisibility`. Without this a
// single user could store an unbounded map and bloat the workspace file (or the
// Postgres JSONB mirror).
export const MAX_PREFERENCES_BYTES = 64 * 1024;
export const MAX_COLUMN_RESOURCES = 200;
export const MAX_COLUMN_ENTRIES = 200;
const MAX_RESOURCE_NAME_LENGTH = 100;

const CONTRACT_KEYS = ['theme', 'density', 'columnVisibility'];

// Keys that must never be copied from a client payload: assigning them walks the
// prototype chain and would pollute every object in the process. `JSON.parse`
// happily produces an own `__proto__` key, so this is a real input, not a
// theoretical one.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeKey(key) {
  return typeof key === 'string' && key.length > 0 && !DANGEROUS_KEYS.has(key);
}

/** Fresh defaults; a new object each call so callers cannot mutate a shared constant. */
export function defaultPreferences() {
  return { theme: 'system', density: 'comfortable', columnVisibility: {} };
}

/**
 * Keep only the safe, well-typed columnVisibility entries. Lenient on purpose:
 * this runs on reads (and on the merge base), where an out-of-contract value
 * should degrade to the default rather than fail the request. Writes go through
 * `validatePreferencesPatch`, which rejects instead. Returns `null` when the
 * value is absent so callers can tell "not provided" from "{}".
 */
export function sanitizeColumnVisibility(value) {
  if (!isPlainObject(value)) return null;
  const clean = {};
  for (const [resource, columns] of Object.entries(value)) {
    if (!isSafeKey(resource) || resource.length > MAX_RESOURCE_NAME_LENGTH) continue;
    if (typeof columns === 'boolean') {
      clean[resource] = columns;
      continue;
    }
    if (!Array.isArray(columns)) continue;
    clean[resource] = columns
      .filter((column) => typeof column === 'string' && column.trim().length > 0)
      .map((column) => column.trim())
      .slice(0, MAX_COLUMN_ENTRIES);
  }
  return clean;
}

/**
 * Coerce whatever is on disk into the public contract. Unknown/legacy keys are
 * dropped from the response but left untouched on the stored user, so the older
 * `/api/users/me/preferences` shape (`sidebarCollapsed`, `pageSize`) keeps
 * working. Out-of-contract values fall back to the defaults rather than leaking
 * through.
 */
export function normalizePreferences(stored) {
  const preferences = defaultPreferences();
  if (!isPlainObject(stored)) return preferences;
  if (PREFERENCE_THEMES.includes(stored.theme)) preferences.theme = stored.theme;
  if (PREFERENCE_DENSITIES.includes(stored.density)) preferences.density = stored.density;
  const columnVisibility = sanitizeColumnVisibility(stored.columnVisibility);
  if (columnVisibility) preferences.columnVisibility = columnVisibility;
  return preferences;
}

/**
 * Validate a PUT/PATCH body and produce the sanitized patch to merge. Rejects
 * (rather than silently dropping) unknown keys, out-of-contract enums and
 * malformed column maps so a caller can never believe a typo was saved.
 *
 * @returns {{ ok: true, patch: object } | { ok: false, status: number, error: string }}
 */
export function validatePreferencesPatch(body) {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: 'Preferences must be a JSON object' };
  }

  // Size guard runs first so an oversized payload never reaches the merge.
  let serialized;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return { ok: false, status: 400, error: 'Preferences must be valid JSON' };
  }
  if (serialized.length > MAX_PREFERENCES_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Preferences payload exceeds ${MAX_PREFERENCES_BYTES} bytes`,
    };
  }

  for (const key of Object.keys(body)) {
    if (!CONTRACT_KEYS.includes(key)) {
      return { ok: false, status: 400, error: `Unknown preference: ${key}` };
    }
  }

  const patch = {};

  if (body.theme !== undefined) {
    if (!PREFERENCE_THEMES.includes(body.theme)) {
      return {
        ok: false,
        status: 400,
        error: `theme must be one of: ${PREFERENCE_THEMES.join(', ')}`,
      };
    }
    patch.theme = body.theme;
  }

  if (body.density !== undefined) {
    if (!PREFERENCE_DENSITIES.includes(body.density)) {
      return {
        ok: false,
        status: 400,
        error: `density must be one of: ${PREFERENCE_DENSITIES.join(', ')}`,
      };
    }
    patch.density = body.density;
  }

  if (body.columnVisibility !== undefined) {
    if (!isPlainObject(body.columnVisibility)) {
      return { ok: false, status: 400, error: 'columnVisibility must be an object' };
    }
    const entries = Object.entries(body.columnVisibility);
    if (entries.length > MAX_COLUMN_RESOURCES) {
      return {
        ok: false,
        status: 400,
        error: `columnVisibility supports at most ${MAX_COLUMN_RESOURCES} resources`,
      };
    }
    const clean = {};
    for (const [resource, columns] of entries) {
      if (!isSafeKey(resource) || resource.length > MAX_RESOURCE_NAME_LENGTH) {
        return { ok: false, status: 400, error: `Invalid columnVisibility resource: ${resource}` };
      }
      if (typeof columns === 'boolean') {
        clean[resource] = columns;
        continue;
      }
      if (!Array.isArray(columns)) {
        return {
          ok: false,
          status: 400,
          error: `columnVisibility.${resource} must be a boolean or an array of column names`,
        };
      }
      if (columns.length > MAX_COLUMN_ENTRIES) {
        return {
          ok: false,
          status: 400,
          error: `columnVisibility.${resource} supports at most ${MAX_COLUMN_ENTRIES} columns`,
        };
      }
      const names = [];
      for (const column of columns) {
        if (typeof column !== 'string' || column.trim() === '') {
          return {
            ok: false,
            status: 400,
            error: `columnVisibility.${resource} must contain non-empty column names`,
          };
        }
        names.push(column.trim());
      }
      clean[resource] = names;
    }
    patch.columnVisibility = clean;
  }

  return { ok: true, patch };
}

/**
 * Merge a validated patch into the raw stored preferences. Non-contract keys on
 * the stored record are preserved, and `columnVisibility` is merged key-by-key
 * (per resource) so a `theme`-only update never erases the column map.
 */
export function mergePreferences(current, patch) {
  const base = isPlainObject(current) ? { ...current } : {};
  for (const key of Object.keys(base)) {
    if (DANGEROUS_KEYS.has(key)) delete base[key];
  }

  const next = { ...base, ...patch };

  next.columnVisibility = {
    ...(sanitizeColumnVisibility(base.columnVisibility) || {}),
    ...(patch.columnVisibility || {}),
  };

  return next;
}
