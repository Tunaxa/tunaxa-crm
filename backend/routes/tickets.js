import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now } from '../helpers.js';
import { broadcast } from './sse.js';

const TICKET_STAGES = ['New', 'In Progress', 'Awaiting Client', 'Resolved'];
const DEFAULT_SLA = { firstResponseHours: 4, resolutionHours: 48 };

function slaStatus(ticket, sla) {
  if (!ticket || ticket.stage === 'Resolved') return { status: 'met', firstResponse: 'ok', resolution: 'ok' };
  const first = ticket.firstResponseAt;
  const resolved = ticket.resolvedAt;
  const firstSla = first ? (new Date(first) - new Date(ticket.createdAt)) / 3600000 <= (sla?.firstResponseHours || 4) : null;
  const resSla = resolved ? (new Date(resolved) - new Date(ticket.createdAt)) / 3600000 <= (sla?.resolutionHours || 48) : null;
  const status = firstSla === false || resSla === false ? 'breached' : 'active';
  return { status, firstResponse: firstSla === null ? 'pending' : firstSla ? 'ok' : 'breached', resolution: resSla === null ? 'pending' : resSla ? 'ok' : 'breached' };
}

export default function registerTicketRoutes(app) {
  app.get('/api/tickets', auth, async (req, res) => {
    const db = await readDb();
    const sla = db.ticketSla || DEFAULT_SLA;
    const tickets = (db.tickets || []).map(t => ({ ...t, sla: slaStatus(t, sla) }));
    const stages = TICKET_STAGES.map(stage => ({ stage, count: tickets.filter(t => t.stage === stage).length }));
    res.json({ data: tickets, stages, sla, total: tickets.length });
  });

  app.post('/api/tickets', auth, requireRole('admin', 'member'), async (req, res) => {
    const { subject, contact, contactEmail, priority = 'Normal', description = '', source = 'Email' } = req.body || {};
    if (!subject) return res.status(400).json({ error: 'Ticket subject is required' });
    const ticket = await mutateDb(db => {
      if (!db.tickets) db.tickets = [];
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

  app.post('/api/tickets/:id/comment', auth, requireRole('admin', 'member'), async (req, res) => {
    const { body } = req.body || {};
    if (!body) return res.status(400).json({ error: 'Comment body is required' });
    const saved = await mutateDb(db => {
      const ticket = (db.tickets || []).find(t => t.id === req.params.id);
      if (!ticket) return null;
      if (!ticket.comments) ticket.comments = [];
      ticket.comments.unshift({ id: id('comment'), body, author: req.user.name, createdAt: now() });
      if (!ticket.firstResponseAt) ticket.firstResponseAt = now();
      return ticket;
    });
    if (!saved) return res.status(404).json({ error: 'Ticket not found' });
    res.status(201).json(saved);
  });

  app.delete('/api/tickets/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const ok = await mutateDb(db => {
      const index = (db.tickets || []).findIndex(t => t.id === req.params.id);
      if (index < 0) return false;
      db.tickets.splice(index, 1);
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ ok: true });
  });

  // SLA summary board
  app.get('/api/tickets/sla/summary', auth, async (req, res) => {
    const db = await readDb();
    const sla = db.ticketSla || DEFAULT_SLA;
    const tickets = db.tickets || [];
    const open = tickets.filter(t => t.stage !== 'Resolved');
    let breached = 0, pending = 0, ok = 0;
    for (const t of open) {
      const s = slaStatus(t, sla);
      if (s.firstResponse === 'breached') breached++;
      if (s.firstResponse === 'pending') pending++;
      if (s.firstResponse === 'ok') ok++;
    }
    res.json({ sla, open: open.length, breached, pending, ok, resolved: tickets.filter(t => t.stage === 'Resolved').length });
  });

  app.put('/api/tickets/sla', auth, requireRole('admin'), async (req, res) => {
    const { firstResponseHours, resolutionHours } = req.body || {};
    const saved = await mutateDb(db => {
      db.ticketSla = { firstResponseHours: Number(firstResponseHours) || 4, resolutionHours: Number(resolutionHours) || 48 };
      return db.ticketSla;
    });
    res.json(saved);
  });
}