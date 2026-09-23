import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { startEmailSync, stopEmailSync, syncInboxOnce } from './emailSync.js';
import { normalizeEmail } from '../helpers.js';

const imap = vi.hoisted(() => ({
  configs: [],
  fetchCalls: 0,
  mailbox: { exists: 1, uidNext: 1004 },
  messages: [],
  connectError: null,
  holdConnect: false,
  releaseConnect: null,
  logoutError: null,
}));

const parser = vi.hoisted(() => ({ row: null }));

const storeMock = vi.hoisted(() => ({ db: null, mutateCount: 0 }));

vi.mock('imapflow', () => {
  class MockImapFlow {
    constructor(config) {
      imap.configs.push(config);
      this.config = config;
      this.mailbox = imap.mailbox;
    }
    async connect() {
      if (imap.connectError) throw imap.connectError;
      if (imap.holdConnect)
        return new Promise(resolve => {
          imap.releaseConnect = resolve;
        });
    }
    async mailboxOpen() {}
    async *fetch() {
      imap.fetchCalls += 1;
      for (const message of imap.messages) yield message;
    }
    async logout() {
      if (imap.logoutError) throw imap.logoutError;
    }
  }
  return { ImapFlow: MockImapFlow };
});

vi.mock('mailparser', () => ({
  simpleParser: vi.fn(async source =>
    typeof parser.row === 'function' ? parser.row(source) : parser.row,
  ),
}));

vi.mock('../store.js', () => ({
  readDb: async () => storeMock.db,
  mutateDb: async mutator => {
    const result = mutator(storeMock.db);
    storeMock.mutateCount += 1;
    return result;
  },
}));

function makeDb(overrides = {}) {
  return {
    settings: {
      imap: {
        host: 'imap.example.com',
        port: 993,
        secure: true,
        auth: { user: 'sync@example.com', pass: 'secret' },
        lastSeenUid: 1000,
      },
    },
    contacts: [{ id: 'contact_1', name: 'Jane Doe', email: 'jane.doe@example.com' }],
    activities: [],
    ...overrides,
  };
}

function resetMocks() {
  storeMock.db = makeDb();
  storeMock.mutateCount = 0;
  imap.configs.length = 0;
  imap.fetchCalls = 0;
  imap.messages = [];
  imap.mailbox = { exists: 1, uidNext: 1004 };
  imap.connectError = null;
  imap.holdConnect = false;
  imap.releaseConnect = null;
  imap.logoutError = null;
  parser.row = null;
  vi.clearAllMocks();
}

const sampleParse = () => ({
  from: { value: [{ address: '"Jane Doe" <Jane.Doe@Example.com>' }] },
  subject: 'Hello there',
  text: 'Body text',
  html: '',
  messageId: '<msg-sync@host>',
  date: new Date('2026-09-20T10:00:00Z'),
});

beforeEach(() => {
  resetMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  stopEmailSync();
  vi.useRealTimers();
});

describe('emailSync', () => {
  it('skips sync gracefully when IMAP settings are empty', async () => {
    storeMock.db = { settings: {}, contacts: [], activities: [] };
    const result = await syncInboxOnce();
    expect(imap.configs).toHaveLength(0);
    expect(storeMock.mutateCount).toBe(0);
    expect(result).toEqual({ skipped: true, reason: 'not-configured' });
  });

  it('skips overlapping runs while a previous sync is in flight', async () => {
    imap.holdConnect = true;
    startEmailSync();
    vi.advanceTimersByTime(300_000);
    await Promise.resolve();
    vi.advanceTimersByTime(300_000);
    await Promise.resolve();
    expect(imap.configs).toHaveLength(1);
    imap.releaseConnect?.();
  });

  it('connects, parses mail, matches contacts, creates activities and advances cursor in a single atomic write', async () => {
    imap.messages = [{ uid: 1001, source: Buffer.from('one') }, { uid: 1002, source: Buffer.from('two') }];
    imap.mailbox = { exists: 2, uidNext: 1004 };
    parser.row = source => ({
      ...sampleParse(),
      messageId: `<m-${String(source)}@host>`,
    });

    startEmailSync();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(imap.configs).toHaveLength(1);
    expect(imap.configs[0]).toMatchObject({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      auth: { user: 'sync@example.com', pass: 'secret' },
      logger: false,
    });

    const { activities } = storeMock.db;
    expect(activities).toHaveLength(2);
    expect(activities[0]).toMatchObject({
      type: 'Email',
      contactId: 'contact_1',
      dealId: null,
      subject: 'Hello there',
      body: 'Body text',
      direction: 'inbound',
      createdAt: '2026-09-20T10:00:00.000Z',
      metadata: {
        messageId: '<m-one@host>',
        uid: 1001,
        from: 'jane.doe@example.com',
      },
    });
    expect(activities[1].metadata.uid).toBe(1002);
    expect(activities[1].metadata.from).toBe('jane.doe@example.com');

    expect(storeMock.db.settings.imap.lastSeenUid).toBe(1002);
    expect(storeMock.mutateCount).toBe(1);
  });

  it('ignores incoming emails whose sender does not exist in db.contacts', async () => {
    imap.messages = [{ uid: 1001, source: Buffer.from('one') }];
    imap.mailbox = { exists: 1, uidNext: 1004 };
    parser.row = () => ({
      ...sampleParse(),
      from: { value: [{ address: 'stranger@other.com' }] },
      messageId: '<m-1@host>',
    });

    const result = await syncInboxOnce();

    expect(storeMock.db.activities).toHaveLength(0);
    expect(storeMock.db.settings.imap.lastSeenUid).toBe(1001);
    expect(result.created).toBe(0);
  });

  it('does not create duplicate activities for an already-seen messageId or uid', async () => {
    imap.messages = [{ uid: 1001, source: Buffer.from('one') }, { uid: 1002, source: Buffer.from('two') }];
    imap.mailbox = { exists: 2, uidNext: 1004 };
    parser.row = source => ({
      ...sampleParse(),
      messageId: `<m-${String(source)}@host>`,
    });

    await syncInboxOnce();
    expect(storeMock.db.activities).toHaveLength(2);

    await syncInboxOnce();
    expect(storeMock.db.activities).toHaveLength(2);
    expect(storeMock.db.settings.imap.lastSeenUid).toBe(1002);
  });

  it('skips the fetch when the mailbox is empty or the cursor is already current', async () => {
    imap.mailbox = { exists: 0, uidNext: 1004 };
    storeMock.db.settings.imap.lastSeenUid = 1003;
    let result = await syncInboxOnce();
    expect(imap.fetchCalls).toBe(0);
    expect(storeMock.mutateCount).toBe(0);
    expect(result.skipped).toBe(true);

    imap.mailbox = { exists: 3, uidNext: 1004 };
    storeMock.db.settings.imap.lastSeenUid = 1004;
    result = await syncInboxOnce();
    expect(imap.fetchCalls).toBe(0);
    expect(result.skipped).toBe(true);
  });

  it('gracefully catches connection errors without throwing unhandled promise rejections', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    imap.connectError = new Error('ECONNRESET');

    const result = await syncInboxOnce();

    expect(result.error).toBe('ECONNRESET');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('swallows logout failures so socket drops do not surface as unhandled rejections', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    imap.logoutError = new Error('socket closed');
    imap.messages = [{ uid: 1001, source: Buffer.from('one') }];
    imap.mailbox = { exists: 1, uidNext: 1004 };
    parser.row = sampleParse;

    const result = await syncInboxOnce();

    expect(result.error).toBeUndefined();
    expect(storeMock.db.activities).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('falls back to environment variables when settings are absent', async () => {
    storeMock.db = makeDb({ settings: {} });
    process.env.IMAP_HOST = 'env.imap.example.com';
    process.env.IMAP_USER = 'env@example.com';
    process.env.IMAP_PASS = 'env-secret';
    imap.messages = [{ uid: 1001, source: Buffer.from('one') }];
    imap.mailbox = { exists: 1, uidNext: 1004 };
    parser.row = sampleParse;

    try {
      const result = await syncInboxOnce();
      expect(result.error).toBeUndefined();
      expect(imap.configs).toHaveLength(1);
      expect(imap.configs[0]).toMatchObject({
        host: 'env.imap.example.com',
        auth: { user: 'env@example.com', pass: 'env-secret' },
      });
    } finally {
      delete process.env.IMAP_HOST;
      delete process.env.IMAP_USER;
      delete process.env.IMAP_PASS;
    }
  });
});

describe('normalizeEmail', () => {
  it('normalizes display-name headers to a lowercased address', () => {
    expect(normalizeEmail('"Jane Doe" <Jane.Doe@EXAMPLE.com>')).toBe('jane.doe@example.com');
    expect(normalizeEmail('Jane Doe <jane@example.com>')).toBe('jane@example.com');
  });

  it('lowercases and trims plain addresses', () => {
    expect(normalizeEmail('   USER@Mail.Com ')).toBe('user@mail.com');
  });

  it('strips whole-string quoting', () => {
    expect(normalizeEmail("'jane@example.com'")).toBe('jane@example.com');
  });

  it('returns null for nullish or empty input', () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
  });

  it('returns null for invalid addresses', () => {
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail('a@b@c.com')).toBeNull();
    expect(normalizeEmail('has space@x.com')).toBeNull();
  });
});