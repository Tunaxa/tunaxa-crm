import { auth } from '../middleware/auth.js';
import { readDb } from '../store.js';
import { query } from '../db/pg.js';
import { buildResourceSchema, listResources } from '../services/schema.js';
import { getFieldPermissions, objectTypeOf } from './permissions.js';

const FALLBACK_CODES = new Set([
  '42P01',
  'ECONNREFUSED',
  'ETIMEDOUT',
  '3D000',
  '28P01',
]);

let pgAvailable = null;

async function pgReady() {
  if (pgAvailable === null) {
    try {
      await query('SELECT 1 FROM pipeline_definitions LIMIT 1');
      pgAvailable = true;
    } catch (error) {
      if (FALLBACK_CODES.has(error?.code)) pgAvailable = false;
      else throw error;
    }
  }
  return pgAvailable;
}

function fromRow(row) {
  let stages = [];
  try {
    const raw = row.stages;
    stages = Array.isArray(raw) ? raw : JSON.parse(String(raw || '[]'));
  } catch {
    stages = [];
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    entityType: row.entity_type || 'deal',
    isDefault: Boolean(row.is_default),
    stages: Array.isArray(stages) ? stages : [],
  };
}

function jsonList(list, tenant) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && String(p.workspaceId ?? p.workspace_id ?? 'default') === tenant)
    .map((p) => ({
      id: p.id,
      workspaceId: p.workspaceId ?? p.workspace_id,
      name: p.name,
      entityType: p.entityType || 'deal',
      isDefault: Boolean(p.isDefault),
      stages: Array.isArray(p.stages) ? p.stages : [],
    }));
}

async function listPipelineDefinitions(tenant, db) {
  if (await pgReady()) {
    const { rows } = await query(
      `SELECT id, workspace_id, name, entity_type, is_default, stages
         FROM pipeline_definitions
        WHERE workspace_id = $1
        ORDER BY created_at ASC, id ASC`,
      [tenant],
    );
    return rows.map(fromRow);
  }
  return jsonList(db.pipelineDefinitions, tenant);
}

const tenantOf = (req) =>
  req.user?.workspaceId || req.user?.workspace_id || 'default';

export default function registerSchemaRoutes(app) {
  app.get('/api/schema/:resource', auth, async (req, res) => {
    try {
      const db = await readDb();
      const resource = String(req.params.resource || '');
      const schemaProbe = buildResourceSchema(resource, { db });
      if (!schemaProbe) {
        return res.status(404).json({
          error:
            `Unknown resource "${resource}". ` +
            `Supported resources: ${listResources().join(', ')}.`,
        });
      }

      const workspaceId = tenantOf(req);
      const pipelineDefinitions = await listPipelineDefinitions(workspaceId, db);
      const fieldPerms = getFieldPermissions(
        db,
        objectTypeOf(resource),
        req.user.role,
      );

      const schema = buildResourceSchema(resource, {
        db,
        settings: db.settings,
        workspaceId,
        pipelineDefinitions,
        fieldPerms,
      });

      if (!schema) {
        return res.status(404).json({
          error:
            `Unknown resource "${resource}". ` +
            `Supported resources: ${listResources().join(', ')}.`,
        });
      }

      res.json(schema);
    } catch (error) {
      console.error('[schema] reflection failed:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
