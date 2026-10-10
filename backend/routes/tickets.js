import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now } from '../helpers.js';
import { broadcast } from './sse.js';
import { repoFor } from '../db/repositories/index.js';
import { pgToLegacy, legacyToPg } from '../db/legacy-shape.js';
import {
  normalizeListQuery,
  toRepositorySort,
  wantsEnvelope,
} from '../middleware/pagination.js';
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
// walk. It is a safety valve, not a result limit: exceeding it throws instead of
// returning a quietly short board, because a truncated SLA summary is worse than
// a failed request.
const MAX_PAGES = 1000;
// Mirrors the workspace_id DEFAULT on the tables (migration 003). The column is
// nullable, so a write that omits it is filed under `default` rather than
// rejected, which is why every insert here sets it explicitly.
const DEFAULT_WORKSPACE = 'default';

function slaStatus(ticket, sla) {
  if (!ticket || isTerminalStage(ticket.stage)) return { status: 'met', firstResponse: 'ok', resolution: 'ok' };
  const first = ticket.firstResponseAt;
  const resolved = ticket.resolvedAt;
  const firstSla = first ? (new Date(first) - new Date(ticket.createdAt)) / 3600000 <= (sla?.firstResponseHours || 4) : null;
  const resSla = resolved ? (new Date(resolved) - new Date(ticket.createdAt)) / 3600000 <= (sla?.resolutionHours || 48) : null;
  const status = firstSla === false || resSla === false ? 'breached' : 'active';
  return { status, firstResponse: firstSla === null ? 'pending' : firstSla ? 'ok' : 'breached', resolution: resSla === null ? 'pending' : resSla ? 'ok' : 'breached' };
}

// Tickets moved to Postgres in migration 007, so this handler reads and writes
// through the repository. The envelope shape ({ data, stages, sla, total }) is
// unchanged: the SLA board and the stage counts are computed from the full set,
// so this pages through the whole result rather than stopping at one page.
async function loadTickets(filters = {}, sortBy = 'created_at:desc') {
  const repo = repoFor('tickets');
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await repo.findAll({ ...filters, sortBy, page, limit: 100 });
    rows.push(...result.data.map(row => pgToLegacy(row, 'tickets')));
    if (result.data.length === 0 || rows.length >= result.total) break;
    if (page === MAX_PAGES) {
      throw new Error(`Ticket list exceeded ${MAX_PAGES * 100} rows; refusing to return a truncated SLA summary`);
    }
  }
  return rows;
}

// Ticket activity rows are a PG resource, so the "Ticket opened" note has to go
// through the activities repository. Anything left in the JSON store would be
// invisible to every activity view.
async function logTicketActivity(legacy) {
  try {
    await repoFor('activities').create(legacyToPg(legacy, 'activities'));
  } catch (error) {
    // The ticket itself is already committed; a missing timeline entry must not
    // fail the request that created the ticket.
    console.error('[tickets] Failed to persist activity', error.message);
  }
}

// Decorate a mapped ticket with the board verdict plus the concrete breach
// flags. `slaBreached` is recomputed on read so a GET reflects the current clock
// rather than whatever was persisted on the last write. The historical `sla`
// object is kept byte-for-byte stable; the richer flags are siblings.
function withSla(ticket, settings, nowValue) {
  const breach = evaluateSlaBreach(ticket, { now: nowValue, settings });
  return {
    ...ticket,
    sla: slaStatus(ticket, settings),
    firstResponseBreached: breach.firstResponseBreached,
    resolutionBreached: breach.resolutionBreached,
    isBreached: breach.isBreached,
    slaBreached: breach.isBreached,
  };
}

export default function registerTicketRoutes(app) {
  app.get('/api/tickets', auth, async (req, res) => {
    try {
      const db = await readDb();
      const settings = db.ticketSla || DEFAULT_SLA;
      // Forward the filters the repository implements so a filtered board is
      // filtered in SQL rather than after loading everything.
      const filters = {};
      for (const key of ['q', 'stage', 'priority', 'source']) {
        if (req.query[key]) filters[key] = req.query[key];
      }
      const controls = normalizeListQuery(req.query);
      const tickets = (
        await loadTickets(filters, toRepositorySort(controls.sortBy, controls.sortDir))
      ).map(t => withSla(t, settings));
      // Stage counts run over the whole matching set so a paginated request
      // still reports a complete board.
      const stages = buildStageSummary(tickets);
      const total = tickets.length;

      // The default (no pagination params, no envelope) response is the legacy
      // board shape. Adding ?envelope=true or page/limit opts into the uniform
      // paged envelope without changing the legacy contract.
      const paginated =
        wantsEnvelope(req.query) ||
        req.query.page !== undefined ||
        req.query.limit !== undefined;

      const body = { data: tickets, stages, sla: settings, total };
      if (paginated) {
        const start = (controls.page - 1) * controls.limit;
        body.data = tickets.slice(start, start + controls.limit);
        body.page = controls.page;
        body.limit = controls.limit;
        body.totalPages = total === 0 ? 0 : Math.ceil(total / controls.limit);
      }
      res.json(body);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/tickets', auth, requireRole('admin', 'member'), async (req, res) => {
    const { subject, contact, contactEmail, priority = 'Normal', description = '', source = 'Email' } = req.body || {};
    if (!subject) return res.status(400).json({ error: 'Ticket subject is required' });
    try {
      const createdAt = now();
      const db = await readDb();
      const settings = db.ticketSla || DEFAULT_SLA;
      const workspaceId = req.user.workspaceId || DEFAULT_WORKSPACE;
      // Due times are stamped at creation from the priority tier. Only a real
      // workspace override (set via PUT /api/tickets/sla) replaces the tier, so
      // the default settings object must not be passed as if it were one.
      const due = computeSlaDueDates({ priority, createdAt, settings: db.ticketSla });
      const legacy = {
        workspace_id: workspaceId,
        subject,
        contact: contact || '',
        contactEmail: contactEmail || '',
        description,
        priority,
        // `stage` is the column name: slaStatus() and the stage board both
        // branch on it, so the API cannot expose it as `status`.
        stage: 'New',
        source,
        comments: [],
        firstResponseDueAt: due.firstResponseDueAt,
        slaDueAt: due.slaDueAt,
        slaBreached: false,
        stageHistory: [{ stage: 'New', at: createdAt, by: req.user.name }],
        createdAt,
        updatedAt: createdAt
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
        updatedAt: createdAt
      });
      await mutateDb(db => {
        db.audit.unshift({ id: id('audit'), action: `Opened ticket "${subject}"`, actor: req.user.name, createdAt });
      });

      broadcast('ticket.opened', ticket);
      res.status(201).json(withSla(ticket, settings, createdAt));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // The SLA target itself stays in the JSON store: it is a single settings
  // object, not a record set, and 007 has no table for it.
  //
  // Registered before PUT /api/tickets/:id on purpose. Express matches in
  // registration order, so the parameterised route would otherwise swallow
  // "sla" as a ticket id and the settings write would 404.
  app.put('/api/tickets/sla', auth, requireRole('admin'), async (req, res) => {
    const result = await mutateDb(db => {
      db.ticketSla = {
        firstResponseHours: Number(req.body?.firstResponseHours) || 4,
        resolutionHours: Number(req.body?.resolutionHours) || 48,
      };
      return db.ticketSla;
    });
    res.json(result);
  });

  app.put('/api/tickets/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const body = req.body || {};
    const nowIso = now();
    try {
      const repo = repoFor('tickets');
      const existingRow = await repo.findById(req.params.id);
      if (!existingRow) return res.status(404).json({ error: 'Ticket not found' });
      const existing = pgToLegacy(existingRow, 'tickets');

      const db = await readDb();
      const settings = db.ticketSla || DEFAULT_SLA;

      // Validate and derive the transition side effects before touching the row.
      let sideEffects = {};
      const targetStage = body.stage;
      if (targetStage !== undefined && targetStage !== null) {
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
        sideEffects = transitionPatch(existing, targetStage, {
          actor: req.user.name,
          at: nowIso,
        });
      }

      // Only the keys the client actually sent reach the UPDATE, so a partial
      // PUT cannot wipe a stored firstResponseAt/resolvedAt. The request body
      // wins over derived side effects so a caller may pass an explicit stamp.
      const patch = { ...sideEffects, ...body };

      // Backfill due dates for rows created before P2-BE2-02, using the same
      // priority tier rules (or a real workspace override) as creation.
      if (!existing.firstResponseDueAt || !existing.slaDueAt) {
        const due = computeSlaDueDates({
          priority: existing.priority,
          createdAt: existing.createdAt,
          settings: db.ticketSla,
        });
        if (patch.firstResponseDueAt === undefined) patch.firstResponseDueAt = due.firstResponseDueAt;
        if (patch.slaDueAt === undefined) patch.slaDueAt = due.slaDueAt;
      }

      if (targetStage !== undefined && targetStage !== null && targetStage !== existing.stage) {
        const history = Array.isArray(existing.stageHistory) ? existing.stageHistory : [];
        patch.stageHistory = [
          ...history,
          { from: existing.stage, stage: targetStage, at: nowIso, by: req.user.name },
        ];
      }

      // Recompute breach against the merged record so the persisted flag can
      // never be stale after a transition.
      const merged = { ...existing, ...patch };
      patch.slaBreached = evaluateSlaBreach(merged, { now: nowIso, settings }).isBreached;

      const row = await repo.update(req.params.id, legacyToPg(patch, 'tickets'));
      if (!row) return res.status(404).json({ error: 'Ticket not found' });
      const saved = pgToLegacy(row, 'tickets');

      await mutateDb(db => {
        db.audit.unshift({ id: id('audit'), action: `Updated ticket "${existing.subject}"`, actor: req.user.name, createdAt: nowIso });
      });

      broadcast('ticket.updated', saved);
      res.json(withSla(saved, settings, nowIso));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/tickets/:id/comment', auth, requireRole('admin', 'member'), async (req, res) => {
    const { body } = req.body || {};
    if (!body) return res.status(400).json({ error: 'Comment body is required' });
    try {
      // addComment prepends server-side and sets first_response_at on the first
      // comment, replacing the read-modify-write the JSON store used.
      const row = await repoFor('tickets').addComment(req.params.id, {
        id: id('comment'),
        body,
        author: req.user.name,
        createdAt: now()
      });
      if (!row) return res.status(404).json({ error: 'Ticket not found' });
      const db = await readDb();
      res.status(201).json(withSla(pgToLegacy(row, 'tickets'), db.ticketSla || DEFAULT_SLA));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/api/tickets/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    try {
      const ok = await repoFor('tickets').delete(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Ticket not found' });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // SLA summary board
  app.get('/api/tickets/sla/summary', auth, async (req, res) => {
    try {
      const db = await readDb();
      const settings = db.ticketSla || DEFAULT_SLA;
      const tickets = await loadTickets();
      const open = tickets.filter(t => !isTerminalStage(t.stage));
      let breached = 0, pending = 0, ok = 0, resolutionBreached = 0;
      for (const t of open) {
        const s = slaStatus(t, settings);
        if (s.firstResponse === 'breached') breached++;
        if (s.firstResponse === 'pending') pending++;
        if (s.firstResponse === 'ok') ok++;
        if (evaluateSlaBreach(t, { settings }).resolutionBreached) resolutionBreached++;
      }
      res.json({
        sla: settings,
        open: open.length,
        breached,
        pending,
        ok,
        firstResponseBreached: breached,
        resolutionBreached,
        resolved: tickets.filter(t => isTerminalStage(t.stage)).length
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Registered after /api/tickets/sla/summary so the literal route matches first
  // (both are unambiguous, but keeping literal-before-parameter is the rule).
  app.get('/api/tickets/:id', auth, async (req, res) => {
    try {
      const row = await repoFor('tickets').findById(req.params.id);
      if (!row) return res.status(404).json({ error: 'Ticket not found' });
      const db = await readDb();
      res.json(withSla(pgToLegacy(row, 'tickets'), db.ticketSla || DEFAULT_SLA));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
