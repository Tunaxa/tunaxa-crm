// Schema reflection router (P2-BE1-03).
//
//   GET /api/schema/:resource
//
// Returns the complete field metadata for one CRM resource so a client can
// render forms, validation and tables without a hardcoded field list. The
// vocabulary (ticket stages/priorities, deal pipeline stages, custom fields,
// workspace currency) is resolved per request from the same modules the rest of
// the API uses; see services/schema.js for the registry and the builder.
//
// Registered before the generic `/api/:resource` catch-all in server.js so the
// literal `/api/schema/...` prefix always wins. This supersedes the narrower
// handler that previously lived in routes/settings.js.

import { auth } from '../middleware/auth.js';
import { readDb } from '../store.js';
import { buildResourceSchema, listResources } from '../services/schema.js';

export default function registerSchemaRoutes(app) {
  app.get('/api/schema/:resource', auth, async (req, res) => {
    try {
      const db = await readDb();
      const schema = buildResourceSchema(req.params.resource, { db });
      if (!schema) {
        return res.status(404).json({
          error:
            `Unknown resource "${req.params.resource}". ` +
            `Supported resources: ${listResources().join(', ')}.`,
        });
      }
      res.json(schema);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
