import { z } from 'zod';
import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now, paginateAndSort } from '../helpers.js';
import { broadcast } from './sse.js';
import { checkWriteFieldMask } from './permissions.js';
import { repoFor } from '../db/repositories/index.js';
import { pgToLegacy, legacyToPg } from '../db/legacy-shape.js';
import {
  RECOGNIZED_STAGES,
  buildStageSummary,
  canTransition,
  isTerminalStage,
  isValidStage,
} from '../services/ticket-stages.js';
import {
  DEFAULT_SLA,
  computeSlaDueDates,
  evaluateSlaBreach,
  transitionPatch,
} from '../services/sla.js';

// Guards against a misreported `total` turning the paging loop into an infinite
// walk. A truncated SLA/board summary is worse than a failed request.
const MAX_PAGES = 1000;
const DEFAULT_WORKSPACE = 'default';
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertNoForbiddenKeys(value, path = '') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoForbiddenKeys(value[i], `${path}[${i}]`);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      const err = new Error(`Forbidden key "${key}" is not allowed`);
      err.status = 400;
      throw err;
    }
  }
  for (const [key, child] of Object.entries(value)) {
    assertNoForbiddenKeys(child, path ? `${path}.${key}` : key);
  }
}

function workspaceOf(req) {
  return req.user?.workspaceId || req.user?.workspace_id || DEFAULT_WORKSPACE;
}

const slaConfigSchema = z
  .object({
    firstResponseHours: z.coerce.number().finite().gt(0).lte(8760),
    resolutionHours: z.coerce.number().finite().gt(0).lte(8760),
  })
  .strict();

const createTicketSchema = z
  .object({
    subject: z.string().trim().min(1),
    contact: z.string().optional(),
    contactEmail: z.string().optional(),
    priority: z.string().optional(),
    description: z.string().optional(),
    source: z.string().optional(),
    stage: z.string().optional(),
  })
  .passthrough();

const commentSchema = z
  .object({
    body: z.string().trim().min(1),
  })
  .passthrough();

function validateBody(schema, body) {
  assertNoForbiddenKeys(body);
  const parsed = schema.safeParse(body || {});
  if (!parsed.success) {
    const err = new Error(parsed.error.issues[0]?.message || 'Invalid request body');
    err.status = 400;
    throw err;
  }
  return parsed.data;
}

function slaStatus(ticket, sla) {
  if (!ticket || isTerminalStage(ticket.stage)) {
    return { status: 'met', firstResponse: 'ok', resolution: 'ok' };
  }
  const first = ticket.firstResponseAt;
  const resolved = ticket.resolvedAt;
  const firstSla = first
    ? (new Date(first) - new Date(ticket.createdAt)) / 3600000 <=
      (sla?.firstResponseHours || 4)
    : null;
  const resSla = resolved
    ? (new Date(resolved) - new Date(ticket.createdAt)) / 3600000 <=
      (sla?.resolutionHours || 48)
    : null;
  const status = firstSla === false || resSla === false ? 'breached' : 'active';
  return {
    status,
    firstResponse: firstSla === null ? 'pending' : firstSla ? 'ok' : 'breached',
    resolution: resSla === null ? 'pending' : resSla ? 'ok' : 'breached',
  };
}

function withSla(ticket, settings, nowValue) {
  const breach = evaluateSlaBreach(ticket, { now: nowValue, settings });
  return {
    ...ticket,
    sla: slaStatus(ticket, settings),
    firstResponseBreached: breach.firstResponseBreached,
    resolutionBreached: breach.resolutionBreached,
    isBreached: breach.isBreached,
    slaBreached: breach.isBreached,
    firstResponseDueAt: ticket.firstResponseDueAt || breach.firstResponseDueAt,
    slaDueAt: ticket.slaDueAt || breach.slaDueAt,
  };
}

async function loadTickets(filters = {}, workspaceId) {
  const repo = repoFor('tickets');
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await repo.findAll({ ...filters, page, limit: 100, workspaceId });
    rows.push(...result.data.map((row) => pgToLegacy(row, 'tickets')));
    if (result.data.length === 0 || rows.length >= result.total) break;
    if (page === MAX_PAGES) {
      throw new Error(
        `Ticket list exceeded ${MAX_PAGES * 100} rows; refusing to return a truncated SLA summary`,
      );
    }
  }
  return rows;
}

async function logTicketActivity(legacy) {
  try {
    await repoFor('activities').create(legacyToPg(legacy, 'activities'));
  } catch (error) {
    console.error('[tickets] Failed to persist activity', error.message);
  }
}

export default function registerTicketRoutes(app) {
  app.get('/api/tickets', auth, async (req, res) => {
    const workspaceId = workspaceOf(req);
    try {
      const db = await readDb();
      const settings = db.ticketSla || DEFAULT_SLA;
      const filters = {};
      for (const key of ['q', 'stage', 'priority', 'source']) {
        if (req.query[key]) filters[key] = req.query[key];
      }
      const tickets = (await loadTickets(filters, workspaceId)).map((t) =>
        withSla(t, settings),
      );
      // Stage counts describe the whole filtered board, not just the page.
      const stages = buildStageSummary(tickets);
      res.json({ ...paginateAndSort(tickets, req.query), stages, sla: settings });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.post(
    '/api/tickets',
    auth,
    requireRole('admin', 'member'),
    checkWriteFieldMask('ticket'),
    async (req, res) => {
      try {
        const body = validateBody(createTicketSchema, req.body);
        const {
          subject,
          contact = '',
          contactEmail = '',
          priority = 'Normal',
          description = '',
          source = 'Email',
        } = body;
        const createdAt = now();
        const workspaceId = workspaceOf(req);
        const db = await readDb();
        const settings = db.ticketSla || DEFAULT_SLA;
        // Only an explicit workspace override replaces the priority tier.
        const due = computeSlaDueDates({
          priority,
          createdAt,
          settings: db.ticketSla,
        });
        const stage = 'New';
        const legacy = {
          workspace_id: workspaceId,
          subject,
          contact: contact || '',
          contactEmail: contactEmail || '',
          description,
          priority,
          stage,
          source,
          comments: [],
          firstResponseDueAt: due.firstResponseDueAt,
          slaDueAt: due.slaDueAt,
          slaBreached: false,
          stageHistory: [{ stage, at: createdAt, by: req.user.name }],
          createdAt,
          updatedAt: createdAt,
        };
        const row = await repoFor('tickets').create(legacyToPg(legacy, 'tickets'));
        const ticket = pgToLegacy(row, 'tickets');

        await logTicketActivity({
          title: `Ticket opened: ${subject}`,
          type: 'Ticket',
          workspace_id: workspaceId,
          contact: contact || contactEmail || '',
          notes: `Priority ${priority} · ${source}`,
          date: createdAt.slice(0, 10),
          ticketId: ticket.id,
          createdAt,
          updatedAt: createdAt,
        });
        await mutateDb((db2) => {
          db2.audit.unshift({
            id: id('audit'),
            action: `Opened ticket "${subject}"`,
            actor: req.user.name,
            createdAt,
          });
        });

        const decorated = withSla(ticket, settings, createdAt);
        broadcast('ticket.opened', decorated);
        res.status(201).json(decorated);
      } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
      }
    },
  );

  // SLA settings (workspace-wide) live in the JSON store. Registered before
  // /api/tickets/:id so "sla" is not swallowed as an id.
  app.put('/api/tickets/sla', auth, requireRole('admin', 'owner'), async (req, res) => {
    try {
      const body = validateBody(slaConfigSchema, req.body);
      const saved = await mutateDb((db) => {
        db.ticketSla = {
          firstResponseHours: body.firstResponseHours,
          resolutionHours: body.resolutionHours,
        };
        return db.ticketSla;
      });
      res.json(saved);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.put(
    '/api/tickets/:id',
    auth,
    requireRole('admin', 'member'),
    checkWriteFieldMask('ticket'),
    async (req, res) => {
      const workspaceId = workspaceOf(req);
      const nowIso = now();
      try {
        assertNoForbiddenKeys(req.body);
        const body = req.body || {};
        const repo = repoFor('tickets');
        const existingRow = await repo.findById(req.params.id, workspaceId);
        if (!existingRow) return res.status(404).json({ error: 'Ticket not found' });
        const existing = pgToLegacy(existingRow, 'tickets');

        const db = await readDb();
        const settings = db.ticketSla || DEFAULT_SLA;

        let sideEffects = {};
        const targetStage = body.stage;
        const stageChanged = targetStage !== undefined && targetStage !== null;
        if (stageChanged) {
          if (!isValidStage(targetStage)) {
            return res.status(400).json({
              error: `stage must be one of: ${RECOGNIZED_STAGES.join(', ')}`,
            });
          }
          if (!canTransition(existing.stage, targetStage)) {
            return res.status(400).json({
              error: `invalid stage transition from "${existing.stage}" to "${targetStage}"`,
            });
          }
          if (targetStage !== existing.stage) {
            sideEffects = transitionPatch(existing, targetStage, {
              actor: req.user.name,
              at: nowIso,
            });
          }
        }

        // Preserve dev behavior for clients that don't model transitions but
        // still set stages/timestamps directly.
        if (!stageChanged || targetStage === existing.stage) {
          // no-op transition path keeps history unchanged
        } else {
          const history = Array.isArray(existing.stageHistory) ? existing.stageHistory : [];
          sideEffects.stageHistory = [
            ...history,
            { from: existing.stage, stage: targetStage, at: nowIso, by: req.user.name },
          ];
        }

        // Only keys the client sent reach update; request body wins over derived
        // side effects so explicit stamps can be supplied.
        const patch = { ...sideEffects, ...body, updatedAt: nowIso };
        // Tenant is server-derived, never client-supplied.
        delete patch.workspace_id;
        delete patch.workspaceId;

        // Back-compat: leaving "New" counts as first response, resolving stamps
        // resolution once (when not already derived).
        if (patch.stage && patch.stage !== 'New' && !existing.firstResponseAt && !patch.firstResponseAt) {
          patch.firstResponseAt = nowIso;
        }
        if (patch.stage === 'Resolved' && !existing.resolvedAt && !patch.resolvedAt) {
          patch.resolvedAt = nowIso;
          if (!existing.resolvedBy && !patch.resolvedBy) patch.resolvedBy = req.user.name;
        }
        if (patch.stage === 'Closed' && !existing.closedAt && !patch.closedAt) {
          patch.closedAt = nowIso;
        }

        // Backfill due dates for pre-P2-BE2-02 rows.
        if (!existing.firstResponseDueAt || !existing.slaDueAt) {
          const due = computeSlaDueDates({
            priority: patch.priority || existing.priority,
            createdAt: existing.createdAt,
            settings: db.ticketSla,
          });
          if (patch.firstResponseDueAt === undefined) {
            patch.firstResponseDueAt = due.firstResponseDueAt;
          }
          if (patch.slaDueAt === undefined) {
            patch.slaDueAt = due.slaDueAt;
          }
        }

        const merged = { ...existing, ...patch };
        patch.slaBreached = evaluateSlaBreach(merged, { now: nowIso, settings }).isBreached;

        // For idempotent same-stage updates, avoid duplicating history.
        if (stageChanged && targetStage === existing.stage) {
          delete patch.stageHistory;
        }

        const row = await repo.update(
          req.params.id,
          legacyToPg(patch, 'tickets'),
          workspaceId,
        );
        if (!row) return res.status(404).json({ error: 'Ticket not found' });
        const saved = pgToLegacy(row, 'tickets');

        await mutateDb((db2) => {
          db2.audit.unshift({
            id: id('audit'),
            action: `Updated ticket "${existing.subject}"`,
            actor: req.user.name,
            createdAt: nowIso,
          });
        });

        const decorated = withSla(saved, settings, nowIso);
        broadcast('ticket.updated', decorated);
        res.json(decorated);
      } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
      }
    },
  );

  app.post(
    '/api/tickets/:id/comment',
    auth,
    requireRole('admin', 'member'),
    async (req, res) => {
      const workspaceId = workspaceOf(req);
      try {
        const body = validateBody(commentSchema, req.body);
        const row = await repoFor('tickets').addComment(
          req.params.id,
          {
            id: id('comment'),
            body: body.body,
            author: req.user.name,
            createdAt: now(),
          },
          workspaceId,
        );
        if (!row) return res.status(404).json({ error: 'Ticket not found' });
        const db = await readDb();
        res
          .status(201)
          .json(withSla(pgToLegacy(row, 'tickets'), db.ticketSla || DEFAULT_SLA));
      } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
      }
    },
  );

  app.delete('/api/tickets/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const workspaceId = workspaceOf(req);
    try {
      const ok = await repoFor('tickets').delete(req.params.id, workspaceId);
      if (!ok) return res.status(404).json({ error: 'Ticket not found' });
      res.json({ ok: true });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });

  // SLA summary board (tenant-scoped)
  app.get('/api/tickets/sla/summary', auth, async (req, res) => {
    const workspaceId = workspaceOf(req);
    try {
      const db = await readDb();
      const settings = db.ticketSla || DEFAULT_SLA;
      const tickets = await loadTickets({}, workspaceId);
      const open = tickets.filter((t) => !isTerminalStage(t.stage));
      let breached = 0;
      let pending = 0;
      let ok = 0;
      let resolutionBreached = 0;
      for (const t of open) {
        const s = slaStatus(t, settings);
        const breach = evaluateSlaBreach(t, { settings });
        if (s.firstResponse === 'breached') breached++;
        if (s.firstResponse === 'pending') pending++;
        if (s.firstResponse === 'ok') ok++;
        if (breach.resolutionBreached) resolutionBreached++;
      }
      res.json({
        sla: settings,
        open: open.length,
        breached,
        pending,
        ok,
        firstResponseBreached: breached,
        resolutionBreached,
        resolved: tickets.filter((t) => isTerminalStage(t.stage)).length,
      });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.get('/api/tickets/:id', auth, async (req, res) => {
    const workspaceId = workspaceOf(req);
    try {
      const row = await repoFor('tickets').findById(req.params.id, workspaceId);
      if (!row) return res.status(404).json({ error: 'Ticket not found' });
      const db = await readDb();
      res.json(withSla(pgToLegacy(row, 'tickets'), db.ticketSla || DEFAULT_SLA));
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });
}
