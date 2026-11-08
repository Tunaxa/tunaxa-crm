import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now, paginateAndSort } from '../helpers.js';
import { createRateLimiter } from '../services/rateLimit.js';

const publicLimiter = createRateLimiter({ windowMs: 60_000, max: 60, prefix: 'booking' });

function generateSlots(availability) {
  const dayStart = Number(availability.startHour ?? 9);
  const dayEnd = Number(availability.endHour ?? 17);
  const duration = Number(availability.durationMinutes ?? 30);
  const slots = [];
  for (let h = dayStart; h < dayEnd; h++) {
    for (let m = 0; m < 60; m += duration) {
      if (m + duration > 60) continue;
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return slots;
}

function findAvailableDate(daysOfWeek, fromDate) {
  if (Array.isArray(daysOfWeek) && daysOfWeek.length) {
    for (let i = 0; i < 21; i++) {
      const d = new Date(fromDate.getTime() + i * 86400000);
      if (daysOfWeek.includes(d.getDay())) return d;
    }
  }
  return fromDate;
}

export default function registerSchedulerRoutes(app) {
  app.get('/api/scheduler/links', auth, async (req, res) => {
    const db = await readDb();
    res.json(paginateAndSort(db.meetingLinks || [], req.query));
  });

  app.post('/api/scheduler/links', auth, requireRole('admin', 'member'), async (req, res) => {
    const { title, durationMinutes = 30, startHour = 9, endHour = 17, daysOfWeek = [1, 2, 3, 4, 5], questions = [], owner = req.user.name } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Meeting title is required' });
    const link = await mutateDb(db => {
      if (!db.meetingLinks) db.meetingLinks = [];
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || id('meet');
      const item = { id: id('link'), slug, title, availability: { durationMinutes, startHour, endHour, daysOfWeek }, questions, owner, bookings: [], createdAt: now(), updatedAt: now() };
      db.meetingLinks.unshift(item);
      return item;
    });
    res.status(201).json(link);
  });

  app.put('/api/scheduler/links/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const saved = await mutateDb(db => {
      const found = (db.meetingLinks || []).find(l => l.id === req.params.id);
      if (!found) return null;
      if (req.body.title) found.title = req.body.title;
      if (req.body.owner) found.owner = req.body.owner;
      if (req.body.availability) found.availability = { ...found.availability, ...req.body.availability };
      if (Array.isArray(req.body.questions)) found.questions = req.body.questions;
      found.updatedAt = now();
      return found;
    });
    if (!saved) return res.status(404).json({ error: 'Meeting link not found' });
    res.json(saved);
  });

  app.delete('/api/scheduler/links/:id', auth, requireRole('admin', 'member'), async (req, res) => {
    const ok = await mutateDb(db => {
      const index = (db.meetingLinks || []).findIndex(l => l.id === req.params.id);
      if (index < 0) return false;
      db.meetingLinks.splice(index, 1);
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'Meeting link not found' });
    res.json({ ok: true });
  });

  // Public booking page data (no auth)
  app.get('/api/scheduler/public/:slug', publicLimiter, async (req, res) => {
    const db = await readDb();
    const link = (db.meetingLinks || []).find(l => l.slug === req.params.slug);
    if (!link) return res.status(404).json({ error: 'Meeting link not found' });
    const date = findAvailableDate(link.availability?.daysOfWeek, new Date());
    const slots = generateSlots(link.availability).filter(slot => {
      const iso = date.toISOString().split('T')[0];
      return !(link.bookings || []).some(b => b.date === iso && b.time === slot);
    });
    res.json({ slug: link.slug, title: link.title, owner: link.owner, questions: link.questions, date: date.toISOString().split('T')[0], slots, durationMinutes: link.availability?.durationMinutes || 30 });
  });

  // Public booking submission
  app.post('/api/scheduler/public/:slug/book', publicLimiter, async (req, res) => {
    const { name, email, date, time, answers = {} } = req.body || {};
    if (!name || !email || !date || !time) return res.status(400).json({ error: 'name, email, date, and time are required' });
    const booking = await mutateDb(db => {
      const link = (db.meetingLinks || []).find(l => l.slug === req.params.slug);
      if (!link) return null;
      if ((link.bookings || []).some(b => b.date === date && b.time === time)) return { conflict: true };
      if (time && !generateSlots(link.availability || {}).includes(time)) return { conflict: true };
      const item = { id: id('booking'), name, email, date, time, answers, createdAt: now() };
      if (!link.bookings) link.bookings = [];
      link.bookings.unshift(item);
      db.activities.unshift({ id: id('activity'), title: `Meeting booked: ${link.title}`, type: 'Meeting', contact: name, notes: `${name} · ${date} ${time}`, date: date, meetingLinkId: link.id, createdAt: now(), updatedAt: now() });
      return item;
    });
    if (!booking) return res.status(404).json({ error: 'Meeting link not found' });
    if (booking.conflict) return res.status(409).json({ error: 'That time slot is no longer available' });
    res.status(201).json(booking);
  });
}