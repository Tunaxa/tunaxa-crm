import { z } from 'zod';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { withWorkspace } from '../middleware/workspace.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { runEmailSyncCycle, getEmailSyncStatus } from '../workers/emailSync.js';

const tenantOf = (req) => req.workspaceId || req.user?.workspaceId || req.user?.workspace_id || 'default';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const emailSyncLimiter = createRateLimiter({ windowMs: 60_000, max: 30, prefix: 'email-sync' });

function hasForbiddenKeys(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasForbiddenKeys);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || hasForbiddenKeys(value[key])) return true;
  }
  return false;
}

const triggerSchema = z.object({
  accountId: z.string().trim().min(1).max(128).optional(),
}).strict();

const statusSchema = z.object({
  accountId: z.string().trim().min(1).max(128).optional(),
}).strict();

function parseInput(schema, input, res) {
  if (hasForbiddenKeys(input)) {
    res.status(400).json({ error: 'Invalid request' });
    return null;
  }
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return null;
  }
  return parsed.data;
}

export default function registerEmailSyncRoutes(app) {
  app.post(
    '/api/email-sync/trigger',
    emailSyncLimiter,
    auth,
    requireRole('admin', 'member'),
    withWorkspace,
    async (req, res) => {
      const body = parseInput(triggerSchema, req.body, res);
      if (!body) return;
      try {
        const result = await runEmailSyncCycle({
          workspaceId: tenantOf(req),
          accountId: body.accountId,
        });
        if (result.error) return res.status(502).json({ error: 'Email sync failed' });
        if (result.skipped) return res.status(200).json(result);
        return res.json(result);
      } catch (error) {
        console.error('[email-sync] manual trigger failed:', error.message);
        return res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  app.get(
    '/api/email-sync/status',
    emailSyncLimiter,
    auth,
    requireRole('admin', 'member'),
    withWorkspace,
    async (req, res) => {
      const query = parseInput(statusSchema, req.query, res);
      if (!query) return;
      try {
        const status = await getEmailSyncStatus({
          workspaceId: tenantOf(req),
          accountId: query.accountId,
        });
        return res.json(status);
      } catch (error) {
        console.error('[email-sync] status read failed:', error.message);
        return res.status(500).json({ error: 'Internal server error' });
      }
    },
  );
}
