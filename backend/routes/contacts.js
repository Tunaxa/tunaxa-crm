import { readDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { getFieldPermissions, applyFieldMasking } from './permissions.js';

// The 360 profile view calls this once per contact it opens, so the budget is
// sized for browsing rather than scraping. Same shape as the other read-side
// limiters (forms and knowledgebase use 120/min).
const associationsLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 120,
  prefix: 'associations',
});

/** Normalises a scalar to a comparable string. */
const text = (value) => String(value ?? '').trim().toLowerCase();

/**
 * Collects every comparable string out of a scalar or a (possibly nested)
 * array field. Objects are ignored so an unexpected nested value cannot throw.
 */
function textSet(value) {
  const out = new Set();
  const push = (item) => {
    if (item === null || item === undefined) return;
    if (Array.isArray(item)) {
      item.forEach(push);
      return;
    }
    if (typeof item === 'object') return;
    const normalised = text(item);
    if (normalised) out.add(normalised);
  };
  push(value);
  return out;
}

/**
 * The values other records may use to point at this contact. Ids are kept
 * separate from labels because a label match is the weaker signal: the store
 * has no enforced foreign keys, so `contact` may hold a name, an email, or a
 * phone number rather than an id.
 */
function contactIdentity(contact) {
  return {
    ids: textSet(contact.id),
    labels: new Set([
      ...textSet(contact.id),
      ...textSet(contact.name),
      ...textSet(contact.email),
      ...textSet(contact.phone),
    ]),
  };
}

/**
 * True when a record points at the contact directly.
 *
 * The link field has been spelled several ways across the codebase: `recordId`
 * is what form submissions and lead scoring write, `contact` carries a name or
 * email as a plain string, and `contactId`/`contactIds`/`contacts` show up on
 * user-created records. All are accepted, otherwise the endpoint would
 * silently return empty groups on real data.
 */
function referencesContact(record, { ids, labels }) {
  for (const value of [
    ...textSet(record.contactId),
    ...textSet(record.contactIds),
    ...textSet(record.recordId),
    ...textSet(record.recordIds),
  ]) {
    if (ids.has(value)) return true;
  }
  for (const value of [
    ...textSet(record.contact),
    ...textSet(record.contacts),
    ...textSet(record.contactName),
  ]) {
    if (labels.has(value)) return true;
  }
  return false;
}

/**
 * Records that belong to a company are linked to a contact through the
 * contact's `company` field, which holds a name rather than an id. This
 * mirrors the existing contact aggregation in routes/ai.js.
 */
function hasCompanyName(record, field, companyName) {
  return companyName !== '' && textSet(record[field]).has(companyName);
}

export default function registerContactRoutes(app) {
  /**
   * GET /api/contacts/:id/associations
   *
   * Everything tied to one contact, grouped by type, for the 360 profile view.
   * Always returns all four keys, using empty arrays when a group has nothing,
   * so the client can render without null checks.
   */
  app.get('/api/contacts/:id/associations', auth, associationsLimiter, async (req, res) => {
    const db = await readDb();
    const contact = (db.contacts || []).find((row) => row.id === req.params.id);

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const who = contactIdentity(contact);
    const companyName = text(contact.company);

    // A company matches the name on the contact, or points back at the contact.
    const companies = (db.companies || []).filter(
      (row) => hasCompanyName(row, 'name', companyName) || referencesContact(row, who),
    );

    const deals = (db.deals || []).filter(
      (row) => hasCompanyName(row, 'company', companyName) || referencesContact(row, who),
    );

    const tasks = (db.tasks || []).filter(
      (row) => hasCompanyName(row, 'company', companyName) || referencesContact(row, who),
    );

    // Meetings are activities with type "meeting". The store capitalises that
    // inconsistently (the seeder writes "Meeting"), so compare normalised.
    const meetings = (db.activities || []).filter(
      (row) => text(row.type) === 'meeting' && referencesContact(row, who),
    );

    // Respect the same per-field masking the generic resource routes apply.
    // No-op unless field permissions are configured for the role.
    const mask = (rows, objectType) => {
      const fieldPerms = getFieldPermissions(db, objectType, req.user.role);
      return fieldPerms ? rows.map((row) => applyFieldMasking(row, fieldPerms)) : rows;
    };

    res.json({
      companies: mask(companies, 'company'),
      deals: mask(deals, 'deal'),
      tasks: mask(tasks, 'task'),
      meetings: mask(meetings, 'activity'),
    });
  });
}