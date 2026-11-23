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

function normalizeWorkspaceId(value) {
  const workspaceId = String(value || '').trim();
  return workspaceId || 'default';
}

function normalizeAccount(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const host = firstNonEmpty(raw.host, raw.imapHost);
  const user = firstNonEmpty(raw.auth?.user, raw.user, raw.imapUser);
  const pass = raw.auth?.pass || raw.pass || raw.imapPassword || '';
  if (!host || !user || !pass) return null;
  const accountId = firstNonEmpty(raw.accountId, raw.id) || (index === 0 ? 'default' : `account-${index + 1}`);
  return {
    accountId,
    host,
    port: Number(raw.port || raw.imapPort) || 993,
    secure: coerceSecure(raw.secure ?? raw.tls),
    auth: { user, pass },
    mailbox: firstNonEmpty(raw.mailbox, raw.mailboxName) || 'INBOX',
    workspaceId: normalizeWorkspaceId(raw.workspaceId),
  };
}

function envAccount() {
  return normalizeAccount({
    host: process.env.IMAP_HOST,
    port: process.env.IMAP_PORT,
    secure: process.env.IMAP_SECURE,
    mailbox: process.env.IMAP_MAILBOX,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    workspaceId: 'default',
  });
}

export function listImapAccounts(db, workspaceId) {
  const requestedWorkspaceId = normalizeWorkspaceId(workspaceId);
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
  return accounts.filter((account) => normalizeWorkspaceId(account.workspaceId) === requestedWorkspaceId);
}

function pickAccount(db, accountId, workspaceId) {
  const accounts = listImapAccounts(db, workspaceId);
  if (!accounts.length) return null;
  if (!accountId) return accounts[0];
  return accounts.find((account) => account.accountId === accountId) || null;
}

function accountState(db, accountId, workspaceId) {
  const key = normalizeWorkspaceId(workspaceId);
  return db?.settings?.emailSync?.accounts?.[key]?.[accountId] || {};
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

export async function runEmailSyncCycle(options = {}) {
  const workspaceId = normalizeWorkspaceId(options.workspaceId);
  const requestedAccountId = options.accountId ? String(options.accountId) : '';
  const db = await readDb();

  const account = pickAccount(db, requestedAccountId, workspaceId);
  if (!account) {
    return {
      skipped: true,
      reason: 'not-configured',
      accountId: requestedAccountId || 'default',
      workspaceId,
    };
  }
  if (activeRuns.has(`${workspaceId}:${account.accountId}`)) {
    return {
      skipped: true,
      reason: 'in-progress',
      accountId: account.accountId,
      workspaceId,
    };
  }

  const runKey = `${workspaceId}:${account.accountId}`;
  activeRuns.add(runKey);

  const run = (async () => {
    try {
      const state = accountState(db, account.accountId, workspaceId);
      const summary = await syncInbox(
        { ...account, lastSeenUid: Number(state.lastSeenUid) || 0 },
        {
          workspaceId,
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
        target.settings.emailSync.accounts[workspaceId] ??= {};
        const previous = target.settings.emailSync.accounts[workspaceId][account.accountId] || {};
        target.settings.emailSync.accounts[workspaceId][account.accountId] = {
          ...previous,
          accountId: account.accountId,
          workspaceId,
          lastSyncedAt,
          lastResult: summarise(summary),
          processedCount,
          lastError,
          lastSeenUid:
            summary.maxUid > (Number(previous.lastSeenUid) || 0)
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
        workspaceId,
      };
    } catch (error) {
      console.error('[email-sync] cycle failed:', error.message);
      return { error: 'Email sync failed', accountId: account.accountId, workspaceId };
    } finally {
      activeRuns.delete(runKey);
    }
  })();

  inFlightRuns.add(run);
  try {
    return await run;
  } finally {
    inFlightRuns.delete(run);
  }
}

export async function getEmailSyncStatus(options = {}) {
  const workspaceId = normalizeWorkspaceId(options.workspaceId);
  const db = await readDb();
  const accounts = listImapAccounts(db, workspaceId);
  const requestedAccountId = options.accountId ? String(options.accountId) : '';
  const account = requestedAccountId
    ? accounts.find((item) => item.accountId === requestedAccountId) || null
    : accounts[0] || null;
  const accountId = requestedAccountId || account?.accountId || 'default';
  const state = accountState(db, accountId, workspaceId);

  return {
    accountId,
    workspaceId,
    configured: Boolean(account),
    running: activeRuns.has(`${workspaceId}:${accountId}`),
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

export function startEmailSyncWorker(options = {}) {
  if (timer) return timer;
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') return null;
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : DEFAULT_INTERVAL_MS;
  timerIntervalMs = intervalMs;
  timer = setInterval(() => {
    void runEmailSyncCycle({});
  }, intervalMs);
  timer.unref?.();
  if (options.runOnStart) void runEmailSyncCycle({});
  return timer;
}

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
