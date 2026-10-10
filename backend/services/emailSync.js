import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { readDb, mutateDb } from '../store.js';
import { normalizeEmail } from '../helpers.js';

const DEFAULT_INTERVAL_MS = 300_000;

let timer = null;
let isSyncing = false;

function imapConfig(db) {
  const stored = db?.settings?.imap;
  const host = (stored?.host || process.env.IMAP_HOST || '').trim();
  if (!host) return null;
  const user = (stored?.auth?.user || process.env.IMAP_USER || '').trim();
  const pass = stored?.auth?.pass || process.env.IMAP_PASS || '';
  if (!user || !pass) return null;
  const port = Number(stored?.port || process.env.IMAP_PORT || 993);
  const secure = stored?.secure !== undefined
    ? Boolean(stored.secure)
    : String(process.env.IMAP_SECURE || 'true').toLowerCase() !== 'false';
  return {
    host,
    port,
    secure,
    auth: { user, pass },
    lastSeenUid: Number(stored?.lastSeenUid || 0),
    logger: false
  };
}

async function safeLogout(client) {
  if (!client) return;
  try {
    await client.logout();
  } catch {
    // Socket may already be dead; never let teardown mask the original error.
  }
}

// One poll tick: connect, fetch UIDs beyond the cursor, match senders to
// contacts, and commit activities + cursor in a single atomic write.
export async function syncInboxOnce() {
  if (isSyncing) return { skipped: true };
  isSyncing = true;
  let client = null;
  try {
    const db = await readDb();
    const config = imapConfig(db);
    if (!config) {
      console.debug('[email-sync] IMAP not configured; skipping tick');
      return { skipped: true, reason: 'not-configured' };
    }
    const { lastSeenUid, ...connection } = config;

    client = new ImapFlow(connection);
    await client.connect();
    await client.mailboxOpen('INBOX');

    const exists = client.mailbox?.exists ?? 0;
    const uidNext = client.mailbox?.uidNext ?? 0;
    if (exists === 0 || lastSeenUid >= uidNext - 1) {
      await safeLogout(client);
      client = null;
      return { skipped: true, reason: 'no-new-messages', fetched: 0, created: 0 };
    }

    const messages = [];
    for await (const msg of client.fetch(
      { uid: `${lastSeenUid + 1}:*` },
      { uid: true, envelope: true, source: true }
    )) {
      messages.push(msg);
    }

    if (messages.length === 0) {
      await safeLogout(client);
      client = null;
      return { fetched: 0, created: 0, lastSeenUid };
    }

    const contacts = db.contacts || [];
    const activities = db.activities || [];
    const newActivities = [];
    let maxUid = lastSeenUid;

    for (const msg of messages) {
      if (msg.uid > maxUid) maxUid = msg.uid;
      let parsed = null;
      try {
        parsed = await simpleParser(msg.source);
      } catch (error) {
        console.error('[email-sync] failed to parse message', msg.uid, error.message);
        continue;
      }

      const senderEmail = normalizeEmail(parsed?.from?.value?.[0]?.address || parsed?.from?.text);
      if (!senderEmail) {
        console.debug('[email-sync] skipping message', msg.uid, '— unparseable sender');
        continue;
      }

      const contact = contacts.find(c => normalizeEmail(c.email) === senderEmail);
      if (!contact) {
        console.debug('[email-sync] skipping message', msg.uid, '— no contact for', senderEmail);
        continue;
      }

      const messageId = parsed.messageId || null;
      const duplicate = activities.some(a =>
        (messageId && a?.metadata?.messageId === messageId) ||
        a?.metadata?.uid === msg.uid
      ) || newActivities.some(a =>
        (messageId && a.metadata.messageId === messageId) ||
        a.metadata.uid === msg.uid
      );
      if (duplicate) {
        console.debug('[email-sync] skipping duplicate message', msg.uid);
        continue;
      }

      newActivities.push({
        id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        title: parsed.subject || '(No Subject)',
        subject: parsed.subject || '(No Subject)',
        type: 'Email',
        contact: contact.name || contact.email || senderEmail,
        notes: parsed.text || parsed.html || '',
        body: parsed.text || parsed.html || '',
        date: (parsed.date || new Date()).toISOString().slice(0, 10),
        recordId: contact.id,
        contactId: contact.id,
        dealId: null,
        direction: 'inbound',
        createdAt: (parsed.date || new Date()).toISOString(),
        metadata: {
          messageId,
          uid: msg.uid,
          from: senderEmail
        }
      });
    }

    if (newActivities.length > 0 || maxUid > lastSeenUid) {
      await mutateDb(db => {
        if (newActivities.length > 0) {
          // Prepended in fetch order (oldest first) so the head of the array
          // stays the earliest message of the batch.
          db.activities.unshift(...newActivities);
        }
        if (maxUid > lastSeenUid) {
          db.settings ??= {};
          db.settings.imap ??= {};
          db.settings.imap.lastSeenUid = maxUid;
        }
      });
    }

    await safeLogout(client);
    client = null;
    return { fetched: messages.length, created: newActivities.length, lastSeenUid: maxUid };
  } catch (error) {
    console.error('[email-sync] sync failed:', error.message);
    return { error: error.message };
  } finally {
    if (client) await safeLogout(client);
    isSyncing = false;
  }
}

export function startEmailSync(intervalMs = DEFAULT_INTERVAL_MS) {
  if (timer) return timer;
  timer = setInterval(() => {
    void syncInboxOnce();
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export function stopEmailSync() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  isSyncing = false;
}
