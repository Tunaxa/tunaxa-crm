export const PREFERENCE_THEMES = ['light', 'dark', 'system'];
export const PREFERENCE_DENSITIES = ['compact', 'comfortable', 'spacious'];

export const MAX_PREFERENCES_BYTES = 64 * 1024;
export const MAX_COLUMN_RESOURCES = 200;
export const MAX_COLUMN_ENTRIES = 200;
const MAX_RESOURCE_NAME_LENGTH = 100;

const CONTRACT_KEYS = ['theme', 'density', 'columnVisibility'];

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeKey(key) {
  return typeof key === 'string' && key.length > 0 && !DANGEROUS_KEYS.has(key);
}

export function defaultPreferences() {
  return { theme: 'system', density: 'comfortable', columnVisibility: {} };
}

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

export function normalizePreferences(stored) {
  const preferences = defaultPreferences();
  if (!isPlainObject(stored)) return preferences;
  if (PREFERENCE_THEMES.includes(stored.theme)) preferences.theme = stored.theme;
  if (PREFERENCE_DENSITIES.includes(stored.density)) preferences.density = stored.density;
  const columnVisibility = sanitizeColumnVisibility(stored.columnVisibility);
  if (columnVisibility) preferences.columnVisibility = columnVisibility;
  return preferences;
}

export function validatePreferencesPatch(body) {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: 'Preferences must be a JSON object' };
  }

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