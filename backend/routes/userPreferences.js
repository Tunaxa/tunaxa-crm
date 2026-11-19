import { auth } from '../middleware/auth.js';
import { readDb, mutateDb } from '../store.js';
import { now } from '../helpers.js';
import {
  PREFERENCE_THEMES,
  mergePreferences,
  normalizePreferences,
  validatePreferencesPatch,
} from '../services/userPreferences.js';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function legacyTheme(storedSettings) {
  const theme = storedSettings?.theme;
  return theme === 'light' || theme === 'dark' ? theme : null;
}

function effectivePreferences(user, storedSettings) {
  const prefs = normalizePreferences(user?.preferences);
  const stored = user?.preferences;
  if (!isPlainObject(stored) || !PREFERENCE_THEMES.includes(stored.theme)) {
    const fromLegacy = legacyTheme(storedSettings);
    if (fromLegacy) prefs.theme = fromLegacy;
  }
  return prefs;
}

function syncLegacySettings(db, userId, mergedUserPreferences) {
  if (!db.settings || typeof db.settings !== 'object') db.settings = {};
  if (!db.settings.userPreferences || typeof db.settings.userPreferences !== 'object') {
    db.settings.userPreferences = {};
  }
  const current = isPlainObject(db.settings.userPreferences[userId])
    ? db.settings.userPreferences[userId]
    : {};
  const next = { ...current };

  const theme = mergedUserPreferences?.theme;
  if (theme === 'light' || theme === 'dark') {
    next.theme = theme;
  }

  db.settings.userPreferences[userId] = next;
}

export default function registerUserPreferencesRoutes(app) {
  app.get('/api/user/preferences', auth, async (req, res) => {
    try {
      const db = await readDb();
      const user = db.users.find((item) => item.id === req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const storedSettings = db.settings?.userPreferences?.[req.user.id];
      res.json({ preferences: effectivePreferences(user, storedSettings) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  const savePreferences = async (req, res) => {
    const validation = validatePreferencesPatch(req.body);
    if (!validation.ok) {
      return res.status(validation.status).json({ error: validation.error });
    }

    try {
      const saved = await mutateDb((db) => {
        const user = db.users.find((item) => item.id === req.user.id);
        if (!user) return null;
        user.preferences = mergePreferences(user.preferences, validation.patch);
        user.updatedAt = now();
        syncLegacySettings(db, req.user.id, user.preferences);
        const storedSettings = db.settings?.userPreferences?.[req.user.id];
        return effectivePreferences(user, storedSettings);
      });
      if (!saved) return res.status(404).json({ error: 'User not found' });
      res.json({ preferences: saved });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };

  app.put('/api/user/preferences', auth, savePreferences);
  app.patch('/api/user/preferences', auth, savePreferences);
}