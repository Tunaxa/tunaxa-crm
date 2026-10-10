// Background inbound email sync worker.
//
// Wraps services/imapSync.js with the pieces a poller needs but the engine
// deliberately does not own:
//
//   - account resolution   settings.imapAccounts[] / settings.imap / IMAP_* env
//   - cursor + status      settings.emailSync.accounts[id] (lastSeenUid,
//                          lastSyncedAt, processedCount, lastError)
//   - concurrency lock     one in-flight run per mailbox, so a manual trigger
//                          landing mid-poll is answered with `in-progress`
//                          instead of a second IMAP session
//   - periodic scheduler   plain interval with unref'd timer and a graceful
//                          stop that drains in-flight cycles
//
// The cursor lives separately from the legacy JSON poller's
// settings.imap.lastSeenUid (services/emailSync.js): the two pollers may run
// side by side, and neither may silently rewind the other's position.

import { readDb, mutateDb } from '../store.js';
import { syncInbox } from '../services/imapSync.js';

export const DEFAULT_INTERVAL_MS = 300_000;

const activeRuns = new Set();
const inFlightRuns = new Set();
let timer = null;
let timerIntervalMs = null;

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function coerceSecure(value) {
  if (value === null || value === undefined || value === '') return true;
  if (typeof value === 'string') return value.toLowerCase() !== 'false';
  return Boolean(value);
}

/**
 * Mailbox credentials come in three spellings depending on where they were
 * configured: nested `auth: { user, pass }` (legacy settings.imap shape),
 * flat `user/pass`, or the `imapHost`/`imapUser`/`imapPassword`/`tls` field
 * names settings pages tend to post. Returns null when the account cannot
 * actually authenticate - a half-configured mailbox must not be polled.
 */
function normalizeAccount(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const host = firstNonEmpty(raw.host, raw.imapHost);
  const user = firstNonEmpty(raw.auth?.user, raw.user, raw.imapUser);
  const pass = raw.auth?.pass || raw.pass || raw.imapPassword || '';
  if (!host || !user || !pass) return null;
  return {
    accountId: firstNonEmpty(raw.accountId, raw.id) || (index === 0 ? 'default' : `account-${index + 1}`),
    host,
    port: Number(raw.port || raw.imapPort) || 993,
    secure: coerceSecure(raw.secure ?? raw.tls),
    auth: { user, pass },
    mailbox: firstNonEmpty(raw.mailbox, raw.mailboxName) || 'INBOX',
    workspaceId: raw.workspaceId || null,
  };
}

function envAccount() {
  return normalizeAccount({
    host: process.env.IMAP_HOST,
    port: process.env.IMAP_PORT,
    secure: process.env.IMAP_SECURE,
    mailbox: process.env.IMAP_MAILBOX,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
  });
}

/** Every configured mailbox, most specific source first. */
export function listImapAccounts(db) {
  const accounts = [];
  const configured = db?.settings?.imapAccounts;
  if (Array.isArray(configured)) {
    configured.forEach((raw, index) => {
      const account = normalizeAccount(raw, index);
      if (account) accounts.push(account);
    });
  }
  if (!accounts.length) {
    const single = normalizeAccount(db?.settings?.imap);
    if (single) accounts.push(single);
  }
  if (!accounts.length) {
    const fromEnv = envAccount();
    if (fromEnv) accounts.push(fromEnv);
  }
  return accounts;
}

function pickAccount(db, accountId) {
  const accounts = listImapAccounts(db);
  if (!accounts.length) return null;
  if (!accountId) return accounts[0];
  return accounts.find((account) => account.accountId === accountId) || null;
}

function accountState(db, accountId) {
  return db?.settings?.emailSync?.accounts?.[accountId] || {};
}

function summarise(summary) {
  return {
    fetched: summary.fetched,
    created: summary.created,
    duplicates: summary.duplicates,
    unmatched: summary.unmatched,
    failed: summary.failed,
    seen: summary.seen,
  };
}

/**
 * One sync cycle for one mailbox.
 *
 * Returns the syncInbox summary plus `lastSyncedAt` / `processedCount`, or a
 * `{ skipped: true, reason }` when nothing ran ('not-configured',
 * 'in-progress'). Errors never reject: they come back as `{ error }` and are
 * persisted as the account's `lastError` so the status endpoint can surface
 * them on the next read.
 */
export async function runEmailSyncCycle(options = {}) {
  const workspaceId = options.workspaceId || 'default';
  const requestedAccountId = options.accountId ? String(options.accountId) : '';
  const db = await readDb();

  const account = pickAccount(db, requestedAccountId);
  if (!account) {
    return {
      skipped: true,
      reason: 'not-configured',
      accountId: requestedAccountId || 'default',
      workspaceId,
    };
  }
  if (activeRuns.has(account.accountId)) {
    return {
      skipped: true,
      reason: 'in-progress',
      accountId: account.accountId,
      workspaceId,
    };
  }

  const effectiveWorkspaceId = workspaceId !== 'default' ? workspaceId : account.workspaceId || 'default';
  activeRuns.add(account.accountId);

  const run = (async () => {
    try {
      const state = accountState(db, account.accountId);
      const summary = await syncInbox(
        { ...account, lastSeenUid: Number(state.lastSeenUid) || 0 },
        {
          workspaceId: effectiveWorkspaceId,
          client: options.client,
          createClient: options.createClient,
          fetch: options.fetch,
        },
      );

      const lastSyncedAt = new Date().toISOString();
      const processedCount = (Number(state.processedCount) || 0) + summary.created;
      const lastError = summary.error || (summary.errors.length ? summary.errors[0] : null);

      await mutateDb((target) => {
        target.settings ??= {};
        target.settings.emailSync ??= {};
        target.settings.emailSync.accounts ??= {};
        const previous = target.settings.emailSync.accounts[account.accountId] || {};
        target.settings.emailSync.accounts[account.accountId] = {
          ...previous,
          accountId: account.accountId,
          workspaceId: effectiveWorkspaceId,
          lastSyncedAt,
          lastResult: summarise(summary),
          processedCount,
          lastError,
          lastSeenUid: summary.maxUid > (Number(previous.lastSeenUid) || 0)
            ? summary.maxUid
            : Number(previous.lastSeenUid) || 0,
        };
      });

      return {
        ...summary,
        lastSeenUid: summary.maxUid,
        lastSyncedAt,
        processedCount,
        lastError,
        workspaceId: effectiveWorkspaceId,
      };
    } catch (error) {
      console.error('[email-sync] cycle failed:', error.message);
      return { error: error.message, accountId: account.accountId, workspaceId: effectiveWorkspaceId };
    } finally {
      activeRuns.delete(account.accountId);
    }
  })();

  inFlightRuns.add(run);
  try {
    return await run;
  } finally {
    inFlightRuns.delete(run);
  }
}

/**
 * Status for the status endpoint: configured/running flags, the last cycle's
 * counts, the cumulative processed count and the persisted cursor. Credentials
 * are never echoed back - only account ids and mailbox names.
 */
export async function getEmailSyncStatus(options = {}) {
  const workspaceId = options.workspaceId || 'default';
  const db = await readDb();
  const accounts = listImapAccounts(db);
  const account = options.accountId
    ? accounts.find((item) => item.accountId === String(options.accountId)) || null
    : accounts[0] || null;
  const accountId = options.accountId ? String(options.accountId) : account?.accountId || 'default';
  const state = accountState(db, accountId);

  return {
    accountId,
    workspaceId: state.workspaceId || workspaceId,
    configured: Boolean(account),
    running: activeRuns.has(accountId),
    lastSyncedAt: state.lastSyncedAt || null,
    lastResult: state.lastResult || null,
    processedCount: Number(state.processedCount) || 0,
    lastSeenUid: Number(state.lastSeenUid) || 0,
    lastError: state.lastError || null,
    intervalMs: timerIntervalMs,
    accounts: accounts.map((item) => ({
      accountId: item.accountId,
      host: item.host,
      mailbox: item.mailbox,
    })),
  };
}

/**
 * Start the periodic poll. Safe to call twice (second call is a no-op), the
 * timer is unref'd so it never keeps the process alive on its own, and an
 * optional immediate first cycle backs `runOnStart`.
 */
export function startEmailSyncWorker(options = {}) {
  if (timer) return timer;
  const intervalMs = Number(options.intervalMs) > 0
    ? Number(options.intervalMs)
    : DEFAULT_INTERVAL_MS;
  timerIntervalMs = intervalMs;
  timer = setInterval(() => {
    void runEmailSyncCycle({});
  }, intervalMs);
  timer.unref?.();
  if (options.runOnStart) void runEmailSyncCycle({});
  return timer;
}

/**
 * Stop scheduling and drain cycles already in flight. The returned promise
 * resolves when every in-flight cycle has settled; callers that do not await
 * it still get the timer stopped synchronously.
 */
export function stopEmailSyncWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    timerIntervalMs = null;
  }
  return Promise.allSettled([...inFlightRuns]);
}

export function isEmailSyncWorkerRunning() {
  return Boolean(timer);
}
