import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb } from './setup.js';
import { mutateDb } from '../store.js';
import { query } from '../db/pg.js';

const ACME = 'ws_acme';
const OTHER = 'ws_other';
const CONTACT_ACME = 'cnt_acme';
const CONTACT_OTHER = 'cnt_other';
const CONTACT_EMPTY = 'cnt_empty';
const EMAIL_ACME = 'ada@acme.test';
const EMAIL_OTHER = 'grace@other.test';
const OPENED_ONE = '2026-01-01T10:00:00.000Z';
const OPENED_TWO = '2026-01-02T10:00:00.000Z';
const OPENED_LATEST = '2026-01-03T10:00:00.000Z';
const OPENED_FOREIGN = '2026-02-01T10:00:00.000Z';
const OPENED_OTHER = '2026-03-01T10:00:00.000Z';

let pgReady = false;
try {
  await query('SELECT 1 FROM contacts LIMIT 1');
  pgReady = true;
} catch {
  pgReady = false;
}

let app;

async function addActivity(id, workspaceId, type, messageId, openedAt) {
  await query(
    `INSERT INTO activities (id, workspace_id, type, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())`,
    [
      id,
      workspaceId,
      type,
      JSON.stringify({
        messageId,
        openedAt,
        clickedAt: openedAt,
        targetUrl: 'https://example.test/offer',
        userAgent: 'Mozilla/5.0',
        ip: '127.0.0.1',
      }),
    ],
  );
}

describe.skipIf(!pgReady)('contact email analytics endpoint', () => {
  beforeAll(async () => {
    await resetTestDb();
    app = (await import('../server.js')).app;
  }, 60_000);

  beforeEach(async () => {
    await resetTestDb();
    await query(
      `INSERT INTO contacts (id, workspace_id, first_name, last_name, email) VALUES
       ($1, $2, 'Ada', 'Lovelace', $3),
       ($4, $5, 'Grace', 'Hopper', $6),
       ($7, $2, 'Empty', 'Contact', 'empty@acme.test')`,
      [CONTACT_ACME, ACME, EMAIL_ACME, CONTACT_OTHER, OTHER, EMAIL_OTHER, CONTACT_EMPTY],
    );

    const stamp = new Date().toISOString();
    const inAnHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await mutateDb((db) => {
      db.users.push(
        { id: 'usr_acme', name: 'Acme', email: 'acme@test.com', password: '', role: 'Owner', workspaceId: ACME, createdAt: stamp },
        { id: 'usr_other', name: 'Other', email: 'other@test.com', password: '', role: 'Owner', workspaceId: OTHER, createdAt: stamp },
      );
      db.sessions.push(
        { token: 'acme-token', userId: 'usr_acme', createdAt: stamp, expiresAt: inAnHour },
        { token: 'other-token', userId: 'usr_other', createdAt: stamp, expiresAt: inAnHour },
      );
      db.messages = [
        { id: 'msg_a1', workspaceId: ACME, channel: 'Email', to: EMAIL_ACME, from: '', contact: EMAIL_ACME, direction: 'Outbound', status: 'Sent', subject: 'First', body: '', read: true, createdAt: stamp, deliveredAt: stamp },
        { id: 'msg_a2', workspaceId: ACME, channel: 'Email', to: EMAIL_ACME, from: '', contact: EMAIL_ACME, direction: 'Outbound', status: 'Sent', subject: 'Second', body: '', read: true, createdAt: stamp, deliveredAt: '' },
        { id: 'msg_a3', workspaceId: ACME, channel: 'Email', to: EMAIL_ACME, from: '', contact: EMAIL_ACME, direction: 'Outbound', status: 'Sent', subject: 'Third', body: '', read: true, createdAt: stamp, deliveredAt: '' },
        { id: 'msg_sms', workspaceId: ACME, channel: 'SMS', to: EMAIL_ACME, from: '', contact: EMAIL_ACME, direction: 'Outbound', status: 'Sent', subject: '', body: '', read: true, createdAt: stamp },
        { id: 'msg_b1', workspaceId: OTHER, channel: 'Email', to: EMAIL_OTHER, from: '', contact: EMAIL_OTHER, direction: 'Outbound', status: 'Sent', subject: 'Foreign', body: '', read: true, createdAt: stamp, deliveredAt: '' },
      ];
    });

    await addActivity('act_a1', ACME, 'email_open', 'msg_a1', OPENED_ONE);
    await addActivity('act_a2', ACME, 'email_open', 'msg_a1', OPENED_TWO);
    await addActivity('act_a3', ACME, 'email_click', 'msg_a1', OPENED_TWO);
    await addActivity('act_a4', ACME, 'email_open', 'msg_a2', OPENED_LATEST);
    await addActivity('act_foreign', OTHER, 'email_open', 'msg_a1', OPENED_FOREIGN);
    await addActivity('act_b1', OTHER, 'email_open', 'msg_b1', OPENED_OTHER);
  });

  afterAll(() => cleanupTestDb());

  it('rejects unauthenticated analytics reads', async () => {
    const res = await request(app).get(`/api/contacts/${CONTACT_ACME}/email-analytics`);
    expect(res.status).toBe(401);
  });

  it('returns the same 404 for foreign and missing contacts', async () => {
    const foreign = await request(app)
      .get(`/api/contacts/${CONTACT_OTHER}/email-analytics`)
      .set('Authorization', 'Bearer acme-token');
    const missing = await request(app)
      .get('/api/contacts/does_not_exist/email-analytics')
      .set('Authorization', 'Bearer acme-token');
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(foreign.body).toEqual({ error: 'Contact not found' });
  });

  it('aggregates only workspace-scoped tracking and exposes no raw PII', async () => {
    const res = await request(app)
      .get(`/api/contacts/${CONTACT_ACME}/email-analytics`)
      .set('Authorization', 'Bearer acme-token');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['data']);
    expect(Object.keys(res.body.data).sort()).toEqual([
      'clickCount',
      'contactId',
      'lastOpenedAt',
      'openRate',
      'openedEmails',
      'sentEmails',
      'totalOpens',
    ]);
    expect(res.body.data).toEqual({
      contactId: CONTACT_ACME,
      sentEmails: 3,
      openedEmails: 2,
      totalOpens: 3,
      clickCount: 1,
      openRate: 66.7,
      lastOpenedAt: OPENED_LATEST,
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('acme-token');
    expect(serialized).not.toContain('userAgent');
    expect(serialized).not.toContain('Mozilla/5.0');
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('https://example.test/offer');
    expect(serialized).not.toContain(OPENED_FOREIGN);
  });

  it('returns explicit zeros when a contact has no sent emails', async () => {
    const res = await request(app)
      .get(`/api/contacts/${CONTACT_EMPTY}/email-analytics`)
      .set('Authorization', 'Bearer acme-token');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      contactId: CONTACT_EMPTY,
      sentEmails: 0,
      openedEmails: 0,
      totalOpens: 0,
      clickCount: 0,
      openRate: 0,
      lastOpenedAt: '',
    });
  });

  it('keeps another workspace isolated in both directions', async () => {
    const denied = await request(app)
      .get(`/api/contacts/${CONTACT_ACME}/email-analytics`)
      .set('Authorization', 'Bearer other-token');
    expect(denied.status).toBe(404);
    expect(denied.body).toEqual({ error: 'Contact not found' });

    const allowed = await request(app)
      .get(`/api/contacts/${CONTACT_OTHER}/email-analytics`)
      .set('Authorization', 'Bearer other-token');
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toEqual({
      contactId: CONTACT_OTHER,
      sentEmails: 1,
      openedEmails: 1,
      totalOpens: 1,
      clickCount: 0,
      openRate: 100,
      lastOpenedAt: OPENED_OTHER,
    });
  });
});
