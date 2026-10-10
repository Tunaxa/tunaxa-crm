// Persistent, per-user UI preference storage (P2-BE1-04).
//
//   GET   /api/user/preferences
//   PUT   /api/user/preferences
//   PATCH /api/user/preferences
//
// Preferences are read from and written to the authenticated user's record in
// the JSON store (`backend/store.js`). That is the same source of truth
// `middleware/auth.js` uses for `req.user`, so the values survive a restart and
// follow the user across browsers and devices.
//
// PUT vs PATCH: the resource is a single object owned by the authenticated
// user, not a collection. A strict PUT-replace would silently drop any
// preference key the client did not resend (including the legacy
// `sidebarCollapsed`/`pageSize` the older `/api/users/me/preferences` endpoint
// still writes), so both verbs are implemented as idempotent upserts that
// deep-merge nested `columnVisibility`. PUT is the full-representation form a
// client sends after saving a settings panel; PATCH is the incremental form.
//
// Registered before the generic `/api/:resource` handler. That handler would not
// match this two-segment path anyway (Express does not cross `/`), but keeping
// the specific router ahead of it documents the intent.

import { auth } from '../middleware/auth.js';
import { readDb, mutateDb } from '../store.js';
import { now } from '../helpers.js';
import {
  mergePreferences,
  normalizePreferences,
  validatePreferencesPatch,
} from '../services/userPreferences.js';

export default function registerUserPreferencesRoutes(app) {
  app.get('/api/user/preferences', auth, async (req, res) => {
    try {
      const db = await readDb();
      const user = db.users.find((item) => item.id === req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json({ preferences: normalizePreferences(user.preferences) });
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
        return normalizePreferences(user.preferences);
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
