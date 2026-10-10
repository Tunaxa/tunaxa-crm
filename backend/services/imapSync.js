// Inbound IMAP sync engine.
//
// One pipeline, three stages:
//
//   syncInbox()            connect (imapflow) -> fetch -> parse -> match -> record
//   parseRawEmail()        MIME -> normalized plain object (mailparser)
//   processInboundEmail()  sender -> tenant contact -> thread/deal -> timeline row
//
// Everything below `processInboundEmail` talks to PostgreSQL through the
// repository layer, so a reply from a known sender lands on the same contact
// timeline the REST API serves. The message id is the deduplication key: the
// worker polls repeatedly and the same RFC message must only ever produce one
// activity (see migrations/013_email_message_tracking.sql for the indexes that
// keep those lookups off a sequential scan).
//
// Tenant isolation is enforced by threading `workspaceId` into every lookup -
// a sender that only exists in another workspace is "no such contact" here,
// never a match.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { query } from '../db/pg.js';
import { repoFor } from '../db/repositories/index.js';
import * as contactsRepo from '../db/repositories/contacts.js';
import { pauseEnrollmentsOnReply } from './sequences.js';
import * as leadsRepo from '../db/repositories/leads.js';
import { normalizeEmail } from '../helpers.js';

const UNSEEN_CRITERION = { seen: false };
const MAX_REPORTED_ERRORS = 10;

/** `<abc@host>` -> `abc@host`. Anything else is trimmed and passed through. */
export function cleanMessageId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const angle = text.match(/<([^<>]+)>/);
  const cleaned = (angle ? angle[1] : text).trim();
  return cleaned || null;
}

/** `references` may be an array or one whitespace-separated header string. */
export function referenceIds(value) {
  if (value === null || value === undefined) return [];
  const parts = Array.isArray(value) ? value : String(value).split(/\s+/);
  const ids = [];
  for (const part of parts) {
    const cleaned = cleanMessageId(part);
    if (cleaned && !ids.includes(cleaned)) ids.push(cleaned);
  }
  return ids;
}

/**
 * Deliberately small HTML scrubber for the `text/html` alternative body: no
 * script/style/iframe-class elements, no inline event handlers, no
 * javascript: links. It is not a full HTML sanitizer - the CRM stores the body
 * for display, and anything richer belongs behind a dedicated sanitizer
 * dependency rather than a regex. Prefer `text` whenever the message has it.
 */
export function sanitizeHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return '';
  return html
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|link|meta|form)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src)\s*=\s*(?:"[^"]*"|'[^']*')?\s*javascript:[^"'\s>]*/gi, '')
    .trim();
}

function addressList(addressObject) {
  const values = Array.isArray(addressObject?.value) ? addressObject.value : [];
  const addresses = [];
  for (const entry of values) {
    const address = normalizeEmail(entry?.address);
    if (address && !addresses.includes(address)) addresses.push(address);
  }
  return addresses;
}

/**
 * MIME -> the normalized shape every later stage consumes. Message ids come
 * back stripped of their angle brackets (cleanMessageId) so the dedup query,
 * the thread query and the stored metadata all speak the same dialect no
 * matter how the header was written.
 */
export async function parseRawEmail(source) {
  const parsed = await simpleParser(source);
  const sender = Array.isArray(parsed?.from?.value) ? parsed.from.value[0] : null;
  const fromAddress = normalizeEmail(sender?.address || parsed?.from?.text);
  const date =
    parsed?.date instanceof Date && !Number.isNaN(parsed.date.getTime())
      ? parsed.date
      : new Date();
  return {
    messageId: cleanMessageId(parsed?.messageId),
    inReplyTo: cleanMessageId(parsed?.inReplyTo),
    references: referenceIds(parsed?.references),
    from: { name: sender?.name || '', address: fromAddress },
    fromAddress,
    to: addressList(parsed?.to),
    cc: addressList(parsed?.cc),
    subject: typeof parsed?.subject === 'string' ? parsed.subject : '',
    text: typeof parsed?.text === 'string' ? parsed.text : '',
    html: sanitizeHtml(parsed?.html),
    date,
  };
}

// Shared workspace predicate: 'default' also reads legacy rows that predate
// the column being populated, matching repositories/contacts.js.
function workspaceScope(param) {
  return `(${param} = $1 OR ($1 = 'default' AND ${param} IS NULL))`;
}

/**
 * Has this message already been recorded on the tenant's timeline? The stored
 * value may or may not carry angle brackets (outbound rows predate the sync
 * worker), so both spellings are checked. Backed by
 * idx_activities_metadata_message_id.
 */
export async function findActivityByMessageId(messageId, workspaceId) {
  const cleaned = cleanMessageId(messageId);
  if (!cleaned) return null;
  const result = await query(
    `SELECT * FROM activities
     WHERE ${workspaceScope('workspace_id')}
       AND (
         metadata->>'messageId' = $2
         OR metadata->>'messageId' = ('<' || $2 || '>')
         OR custom_fields->>'messageId' = $2
         OR custom_fields->>'messageId' = ('<' || $2 || '>')
       )
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId || 'default', cleaned],
  );
  return result.rows[0] || null;
}

/**
 * Walk In-Reply-To / References back to the activity that started the thread.
 * `candidateIds` must already be cleaned (parseRawEmail does that); the stored
 * side is matched in both spellings again.
 */
export async function findThreadActivity(candidateIds, workspaceId) {
  const ids = [];
  for (const candidate of candidateIds || []) {
    const cleaned = cleanMessageId(candidate);
    if (!cleaned) continue;
    for (const variant of [cleaned, `<${cleaned}>`]) {
      if (!ids.includes(variant)) ids.push(variant);
    }
  }
  if (!ids.length) return null;
  const result = await query(
    `SELECT * FROM activities
     WHERE ${workspaceScope('workspace_id')}
       AND (
         metadata->>'messageId' = ANY($2::text[])
         OR custom_fields->>'messageId' = ANY($2::text[])
       )
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId || 'default', ids],
  );
  return result.rows[0] || null;
}

/**
 * The contact's newest deal that is still open. Won/lost deals are terminal,
 * so associating new correspondence with them would resurrect a finished
 * conversation; a reply that belongs to an explicit thread inherits the
 * thread's deal instead (see processInboundEmail).
 */
export async function findActiveDealId(contactId, workspaceId) {
  if (!contactId) return null;
  const result = await query(
    `SELECT id FROM deals
     WHERE ${workspaceScope('workspace_id')}
       AND contact_id = $2
       AND LOWER(COALESCE(stage, '')) NOT IN ('won', 'lost')
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId || 'default', contactId],
  );
  return result.rows[0]?.id || null;
}

function contactDisplayName(contact, fallback) {
  const name = [contact?.first_name, contact?.last_name].filter(Boolean).join(' ').trim();
  return name || contact?.email || fallback;
}

function buildDescription(parsedEmail) {
  const text = typeof parsedEmail?.text === 'string' ? parsedEmail.text.trim() : '';
  if (text) return text;
  return sanitizeHtml(parsedEmail?.html);
}

function buildMetadata(parsedEmail, { threadId, messageId, options }) {
  const metadata = {
    direction: 'inbound',
    messageId,
    inReplyTo: cleanMessageId(parsedEmail?.inReplyTo),
    references: referenceIds(parsedEmail?.references),
    from: parsedEmail?.fromAddress || null,
    fromName: parsedEmail?.from?.name || '',
    to: Array.isArray(parsedEmail?.to) ? parsedEmail.to : [],
    cc: Array.isArray(parsedEmail?.cc) ? parsedEmail.cc : [],
    threadId,
    source: 'imap',
  };
  if (options.accountId) metadata.accountId = options.accountId;
  if (options.mailbox) metadata.mailbox = options.mailbox;
  if (Number.isInteger(options.uid)) metadata.uid = options.uid;
  return metadata;
}

/**
 * Record one inbound message on the tenant timeline.
 *
 * Resolution order:
 *   1. dedup by message id (workspace scoped) -> 'duplicate'
 *   2. sender -> contacts.email (case-insensitive), then leads.email
 *      -> 'unmatched' when neither exists (CRM policy: never invent a
 *      contact from mail we merely received)
 *   3. In-Reply-To / References -> parent activity -> thread id + its deal
 *   4. otherwise the contact's newest open deal
 *
 * Returns `{ status, activity, ... }` where status is one of
 * 'created' | 'duplicate' | 'unmatched' | 'invalid'.
 */
export async function processInboundEmail(parsedEmail, workspaceId, options = {}) {
  const workspace = workspaceId || 'default';
  const fromAddress =
    parsedEmail?.fromAddress ||
    normalizeEmail(parsedEmail?.from?.address) ||
    normalizeEmail(parsedEmail?.from?.text);
  if (!fromAddress) {
    return { status: 'invalid', reason: 'unparseable-sender' };
  }

  const messageId = cleanMessageId(parsedEmail?.messageId);
  if (messageId) {
    const existing = await findActivityByMessageId(messageId, workspace);
    if (existing) {
      return { status: 'duplicate', activity: existing, reason: 'message-already-recorded' };
    }
  }

  const contact = await contactsRepo.findByEmail(fromAddress, workspace);
  let lead = null;
  if (!contact) lead = await leadsRepo.findByEmail(fromAddress, workspace);
  if (!contact && !lead) {
    return { status: 'unmatched', reason: 'no-contact-for-sender', fromAddress };
  }

  const replyIds = [
    ...new Set(
      [parsedEmail?.inReplyTo, ...(parsedEmail?.references || [])]
        .map(cleanMessageId)
        .filter(Boolean),
    ),
  ];
  const parent = replyIds.length ? await findThreadActivity(replyIds, workspace) : null;

  let dealId = parent?.deal_id || null;
  if (!dealId && contact) dealId = await findActiveDealId(contact.id, workspace);

  const threadId =
    cleanMessageId(parent?.metadata?.threadId) ||
    cleanMessageId(parent?.metadata?.messageId) ||
    replyIds[0] ||
    messageId ||
    null;

  const subject = String(parsedEmail?.subject || '').trim() || '(No Subject)';
  const description = buildDescription(parsedEmail);
  const record = contact || lead;
  const sentAt = parsedEmail?.date instanceof Date ? parsedEmail.date : new Date();

  const activity = await repoFor('activities').create({
    workspace_id: workspace,
    type: 'email',
    title: subject,
    subject,
    description,
    contact: contactDisplayName(record, fromAddress),
    direction: 'inbound',
    record_id: record.id,
    entity_type: contact ? 'contact' : 'lead',
    entity_id: record.id,
    contact_id: contact ? contact.id : null,
    deal_id: dealId,
    metadata: buildMetadata(parsedEmail, { threadId, messageId, options }),
    created_at: sentAt.toISOString(),
  });

  if (contact) {
    try {
      await pauseEnrollmentsOnReply({
        contactId: contact.id,
        workspaceId: workspace,
        messageId,
      });
    } catch (error) {
      // Sequence auto-pause is best-effort: a reply must never fail email
      // persistence or the sync cursor advance.
      console.error(`[sequence] pause-on-reply failed for ${contact.id}:`, error?.message || error);
    }
  }

  return {
    status: 'created',
    activity,
    contact,
    lead,
    dealId,
    threadId,
    fromAddress,
    messageId,
  };
}

export function createImapClient(accountConfig = {}) {
  const user = accountConfig.auth?.user ?? accountConfig.user;
  const pass = accountConfig.auth?.pass ?? accountConfig.pass;
  return new ImapFlow({
    host: accountConfig.host,
    port: Number(accountConfig.port) || 993,
    secure: accountConfig.secure !== false,
    auth: { user, pass },
    logger: false,
  });
}

function fetchCriterion(accountConfig, options) {
  if (options.fetch) return options.fetch;
  const sinceUid = Number(options.sinceUid ?? accountConfig.lastSeenUid ?? 0);
  // First poll (no cursor yet) only pulls what the server still marks
  // unread; afterwards the stored UID cursor keeps re-polls O(new mail).
  if (sinceUid > 0) return { uid: `${sinceUid + 1}:*` };
  return UNSEEN_CRITERION;
}

function pushError(summary, message) {
  if (summary.errors.length < MAX_REPORTED_ERRORS) summary.errors.push(message);
  else if (summary.errors.length === MAX_REPORTED_ERRORS) summary.errors.push('...further errors suppressed');
}

function disposeQuietly(client) {
  return Promise.resolve(client.logout()).catch(() => {
    // Socket may already be dead; never let teardown mask the original error.
  });
}

/**
 * One mailbox poll.
 *
 * `options.client` (or `options.createClient`) injects a transport, which is
 * how tests and CI run the full fetch -> parse -> match -> insert path with
 * InMemoryImapClient instead of a live mail server.
 *
 * Messages that end up created or already-known are flagged \\Seen on the
 * server; unmatched senders are left unread so they stay visible for manual
 * triage.
 */
export async function syncInbox(accountConfig = {}, options = {}) {
  const workspaceId = options.workspaceId || accountConfig.workspaceId || 'default';
  const mailbox = options.mailbox || accountConfig.mailbox || 'INBOX';
  const accountId = accountConfig.accountId || 'default';
  const client =
    options.client ||
    (typeof options.createClient === 'function' ? options.createClient(accountConfig) : null) ||
    createImapClient(accountConfig);

  const summary = {
    accountId,
    workspaceId,
    mailbox,
    fetched: 0,
    created: 0,
    duplicates: 0,
    unmatched: 0,
    invalid: 0,
    failed: 0,
    seen: 0,
    maxUid: 0,
    errors: [],
  };
  let connected = false;
  try {
    if (typeof client.connect === 'function') await client.connect();
    connected = true;
    if (typeof client.mailboxOpen === 'function') await client.mailboxOpen(mailbox);

    const criterion = fetchCriterion(accountConfig, options);
    for await (const msg of client.fetch(criterion, {
      uid: true,
      envelope: true,
      source: true,
      flags: true,
    })) {
      summary.fetched += 1;
      const uid = Number(msg?.uid) || 0;
      if (uid > summary.maxUid) summary.maxUid = uid;

      let parsed;
      try {
        parsed = await parseRawEmail(msg.source);
      } catch (error) {
        summary.failed += 1;
        pushError(summary, `parse uid=${uid}: ${error.message}`);
        continue;
      }

      let result;
      try {
        result = await processInboundEmail(parsed, workspaceId, {
          uid,
          accountId,
          mailbox,
        });
      } catch (error) {
        summary.failed += 1;
        pushError(summary, `process uid=${uid}: ${error.message}`);
        continue;
      }

      if (result.status === 'created') summary.created += 1;
      else if (result.status === 'duplicate') summary.duplicates += 1;
      else if (result.status === 'unmatched') summary.unmatched += 1;
      else if (result.status === 'invalid') summary.invalid += 1;

      const markSeen = result.status === 'created' || result.status === 'duplicate';
      if (markSeen && uid && typeof client.messageFlagsAdd === 'function') {
        try {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          summary.seen += 1;
        } catch (error) {
          pushError(summary, `flags uid=${uid}: ${error.message}`);
        }
      }
    }
    return summary;
  } catch (error) {
    summary.error = error.message;
    pushError(summary, error.message);
    return summary;
  } finally {
    if (connected && typeof client.logout === 'function') await disposeQuietly(client);
  }
}

function matchesCriterion(criterion, message) {
  const flags = Array.isArray(message.flags) ? message.flags : [];
  if (criterion?.seen === false && flags.includes('\\Seen')) return false;
  if (criterion?.seen === true && !flags.includes('\\Seen')) return false;
  if (criterion?.uid !== undefined && criterion.uid !== null && criterion.uid !== '') {
    const [lowRaw, highRaw] = String(criterion.uid).split(':');
    const low = Number(lowRaw);
    const high = highRaw === undefined ? low : highRaw === '*' ? Infinity : Number(highRaw);
    const uid = Number(message.uid);
    if (!(uid >= low && uid <= high)) return false;
  }
  return true;
}

/**
 * Transport double for tests/CI: same surface syncInbox touches on a real
 * ImapFlow client (connect / mailboxOpen / fetch / messageFlagsAdd / logout),
 * backed by an in-memory message list. Search support is intentionally narrow
 * - unseen-only and UID ranges - which is exactly what fetchCriterion emits.
 * `options.fetchGate` blocks the fetch iterator (useful for concurrency tests).
 */
export class InMemoryImapClient {
  constructor(messages = [], options = {}) {
    this.messages = messages.map((message) => ({ flags: [], ...message }));
    const highestUid = this.messages.reduce((max, message) => Math.max(max, Number(message.uid) || 0), 0);
    this.mailbox = { name: 'INBOX', exists: this.messages.length, uidNext: highestUid + 1 };
    this.openedMailbox = null;
    this.connected = false;
    this.fetchCriteria = [];
    this.flagUpdates = [];
    this.fetchGate = options.fetchGate || null;
  }

  async connect() {
    this.connected = true;
  }

  async logout() {
    this.connected = false;
  }

  async mailboxOpen(name) {
    this.openedMailbox = name;
    return this.mailbox;
  }

  async *fetch(criterion = {}) {
    this.fetchCriteria.push(criterion);
    if (this.fetchGate) await this.fetchGate;
    for (const message of this.messages) {
      if (!matchesCriterion(criterion, message)) continue;
      yield {
        uid: message.uid,
        source: message.source,
        flags: [...(message.flags || [])],
        envelope: message.envelope ?? null,
      };
    }
  }

  async messageFlagsAdd(sequence, flags = []) {
    this.flagUpdates.push({ sequence, flags });
    for (const message of this.messages) {
      if (String(message.uid) === String(sequence)) {
        message.flags = [...new Set([...(message.flags || []), ...flags])];
      }
    }
    return true;
  }
}
