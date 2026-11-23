import net from 'node:net';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { query } from '../db/pg.js';
import { repoFor } from '../db/repositories/index.js';
import * as contactsRepo from '../db/repositories/contacts.js';
import * as leadsRepo from '../db/repositories/leads.js';
import { normalizeEmail } from '../helpers.js';
import { pauseEnrollmentsOnReply } from './sequences.js';

const UNSEEN_CRITERION = { seen: false };
const MAX_REPORTED_ERRORS = 10;
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.google',
  'instance-data',
]);

function isPrivateIpv4(parts) {
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIpv6(address) {
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80:')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const parts = mapped[1].split('.').map((value) => Number(value));
    return parts.length === 4 && parts.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) && isPrivateIpv4(parts);
  }
  return false;
}

export function assertSafeImapHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (!value) throw new Error('IMAP host is required');
  if (value.includes('@') || value.includes('/') || value.includes('\\') || /\s/.test(value)) {
    throw new Error('IMAP host is not allowed');
  }
  if (BLOCKED_HOSTNAMES.has(value) || value.endsWith('.localhost') || value.endsWith('.local') || value.endsWith('.internal')) {
    throw new Error('IMAP host is not allowed');
  }
  const ipType = net.isIP(value);
  if (ipType === 4) {
    const parts = value.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255) || isPrivateIpv4(parts)) {
      throw new Error('IMAP host is not allowed');
    }
    return value;
  }
  if (ipType === 6) {
    if (isPrivateIpv6(value)) throw new Error('IMAP host is not allowed');
    return value;
  }
  if (!/^[a-z0-9.-]+$/.test(value) || value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    throw new Error('IMAP host is not allowed');
  }
  return value;
}

function assertSafeImapPort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('IMAP port is not allowed');
  }
  return value;
}

export function cleanMessageId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const angle = text.match(/<([^<>]+)>/);
  const cleaned = (angle ? angle[1] : text).trim();
  return cleaned || null;
}

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

export function sanitizeHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
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

function workspaceScope(param) {
  return `(${param} = $1 OR ($1 = 'default' AND ${param} IS NULL))`;
}

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
  const host = assertSafeImapHost(accountConfig.host);
  const port = assertSafeImapPort(accountConfig.port ?? 993);
  return new ImapFlow({
    host,
    port,
    secure: accountConfig.secure !== false,
    auth: { user, pass },
    logger: false,
  });
}

function fetchCriterion(accountConfig, options) {
  if (options.fetch) return options.fetch;
  const sinceUid = Number(options.sinceUid ?? accountConfig.lastSeenUid ?? 0);
  if (sinceUid > 0) return { uid: `${sinceUid + 1}:*` };
  return UNSEEN_CRITERION;
}

function pushError(summary, message) {
  if (summary.errors.length < MAX_REPORTED_ERRORS) summary.errors.push(message);
  else if (summary.errors.length === MAX_REPORTED_ERRORS) summary.errors.push('...further errors suppressed');
}

function disposeQuietly(client) {
  return Promise.resolve(client.logout()).catch(() => {});
}

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
