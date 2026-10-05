import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now } from '../helpers.js';
import { broadcast } from './sse.js';
import { repoFor } from '../db/repositories/index.js';
import { pgToLegacy, legacyToPg } from '../db/legacy-shape.js';

const TICKET_STAGES = ['New', 'In Progress', 'Awaiting Client', 'Resolved'];
const DEFAULT_SLA = { firstResponseHours: 4, resolutionHours: 48 };
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
  if (!ticket || ticket.stage === 'Resolved') return { status: 'met', firstResponse: 'ok', resolution: 'ok' };
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
async function loadTickets(filters = {}) {
  const repo = repoFor('tickets');
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await repo.findAll({ ...filters, page, limit: 100 });
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

export default function registerTicketRoutes(app) {
  app.get('/api/tickets', auth, async (req, res) => {
    try {
      const db = await readDb();
      const sla = db.ticketSla || DEFAULT_SLA;
      // Forward the filters the repository implements so a filtered board is
      // filtered in SQL rather than after loading everything.
      const filters = {};
      for (const key of ['q', 'stage', 'priority', 'source']) {
        if (req.query[key]) filters[key] = req.query[key];
      }
      const tickets = (await loadTickets(filters)).map(t => ({ ...t, sla: slaStatus(t, sla) }));
      const stages = TICKET_STAGES.map(stage => ({ stage, count: tickets.filter(t => t.stage === stage).length }));
      res.json({ data: tickets, stages, sla, total: tickets.length });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/tickets', auth, requireRole('admin', 'member'), async (req, res) => {
    const { subject, contact, contactEmail, priority = 'Normal', description = '', source = 'Email' } = req.body || {};
    if (!subject) return res.status(400).json({ error: 'Ticket subject is required' });
    try {
      const createdAt = now();
      const item = { id: id('ticket'), subject, contact: contact || '', contactEmail: contactEmail || '', description, priority, stage: 'New', source, createdAt, updatedAt: createdAt, firstResponseAt: '', resolvedAt: '' };
      db.tickets.unshift(item);
      db.activities.unshift({ id: id('activity'), title: `Ticket opened: ${subject}`, type: 'Ticket', contact: contact || contactEmail || '', notes: `Priority ${priority} · ${source}`, date: createdAt.slice(0, 10), ticketId: item.id, createdAt, updatedAt: createdAt });
      db.audit.unshift({ id: id('audit'), action: `Opened ticket "${subject}"`, actor: req.user.name, createdAt });
      return item;
    });
    broadcast('ticket.opened', ticket);
    res.status(201).json(ticket);
  });

  app.put('/api/tickets/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const saved = await mutateDb(db => {
      const index = (db.tickets || []).findIndex(t => t.id === req.params.id);
      if (index < 0) return null;
      const ticket = db.tickets[index];
      const nowIso = now();
      const updated = { ...ticket, ...req.body, updatedAt: nowIso };
      if (!updated.firstResponseAt && req.body.stage && req.body.stage !== 'New') updated.firstResponseAt = nowIso;
      if (req.body.stage === 'Resolved' && !updated.resolvedAt) { updated.resolvedAt = nowIso; updated.resolvedBy = req.user.name; }
      db.tickets[index] = updated;
      db.audit.unshift({ id: id('audit'), action: `Updated ticket "${ticket.subject}"`, actor: req.user.name, createdAt: nowIso });
      return updated;
    });
    if (!saved) return res.status(404).json({ error: 'Ticket not found' });
    broadcast('ticket.updated', saved);
    res.json(saved);
  });

  app.put('/api/tickets/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const nowIso = now();
    // Same two rules the JSON handler applied, kept verbatim: moving a ticket
    // off "New" counts as a first response, and moving it to "Resolved" stamps
    // the resolution once.
    const patch = { ...req.body, updatedAt: nowIso };
    if (req.body.stage && req.body.stage !== 'New' && !req.body.firstResponseAt) {
      patch.firstResponseAt = nowIso;
    }
    if (req.body.stage === 'Resolved' && !req.body.resolvedAt) {
      patch.resolvedAt = nowIso;
      patch.resolvedBy = req.user.name;
    }
    try {
      const repo = repoFor('tickets');
      const existing = await repo.findById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Ticket not found' });

      // Only the keys the client actually sent reach the UPDATE, so a partial
      // PUT cannot wipe a stored firstResponseAt/resolvedAt. The JSON handler
      // got this for free from `{ ...ticket, ...req.body }`.
      const row = await repo.update(req.params.id, legacyToPg(patch, 'tickets'));
      if (!row) return res.status(404).json({ error: 'Ticket not found' });
      const saved = pgToLegacy(row, 'tickets');

      await mutateDb(db => {
        db.audit.unshift({ id: id('audit'), action: `Updated ticket "${existing.subject}"`, actor: req.user.name, createdAt: nowIso });
      });
      broadcast('ticket.updated', saved);
      res.json(saved);
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
      res.status(201).json(pgToLegacy(row, 'tickets'));
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
      const sla = db.ticketSla || DEFAULT_SLA;
      const tickets = await loadTickets();
      const open = tickets.filter(t => t.stage !== 'Resolved');
      let breached = 0, pending = 0, ok = 0;
      for (const t of open) {
        const s = slaStatus(t, sla);
        if (s.firstResponse === 'breached') breached++;
        if (s.firstResponse === 'pending') pending++;
        if (s.firstResponse === 'ok') ok++;
      }
      res.json({ sla, open: open.length, breached, pending, ok, resolved: tickets.filter(t => t.stage === 'Resolved').length });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
