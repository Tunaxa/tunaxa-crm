// Inbound IMAP sync: fetch -> MIME parse -> sender/contact match -> timeline.
//
// These tests exercise the full pipeline against PostgreSQL (contacts, deals,
// leads and activities are all Postgres-backed resources), so they follow the
// same convention as rbac-field-mask-write.test.js: resetTestDb() per case,
// direct INSERTs for fixtures, and InMemoryImapClient in place of a live mail
// server - mailparser runs against real RFC 822 buffers, only the transport is
// faked.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { resetTestDb } from "./setup.js";
import { query } from "../db/pg.js";
import { mutateDb } from "../store.js";
import {
  parseRawEmail,
  processInboundEmail,
  syncInbox,
  InMemoryImapClient,
  cleanMessageId,
} from "../services/imapSync.js";
import {
  runEmailSyncCycle,
  getEmailSyncStatus,
  startEmailSyncWorker,
  stopEmailSyncWorker,
  isEmailSyncWorkerRunning,
} from "../workers/emailSync.js";

const ACME = "ws_acme";
const GLOBEX = "ws_globex";
const SARAH_EMAIL = "sarah.connor@cyberdyne.com";

function rawMessage({
  from = `Sarah Connor <${SARAH_EMAIL}>`,
  to = "sales@acme.com",
  subject = "Re: Q3 Proposal Discussion",
  messageId = "<reply-001@cyberdyne.com>",
  inReplyTo = null,
  references = null,
  text = "Thanks, this looks good. Let's move forward.",
  html = "",
  date = "2026-09-22T14:05:00.000Z",
} = {}) {
  const inReply = inReplyTo ? `In-Reply-To: ${inReplyTo}\r\n` : "";
  const refs = references ? `References: ${references}\r\n` : "";
  return Buffer.from(
    `From: ${from}\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${new Date(date).toUTCString()}\r\n` +
      `Message-ID: ${messageId}\r\n` +
      inReply +
      refs +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      `${text}` +
      (html ? `\r\n\r\n<html><body>${html}</body></html>` : ""),
  );
}

async function seedContact({
  id = "cnt_sarah_connor",
  workspaceId = ACME,
  email = SARAH_EMAIL,
  firstName = "Sarah",
  lastName = "Connor",
} = {}) {
  await query(
    `INSERT INTO contacts (id, workspace_id, first_name, last_name, email)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, workspaceId, firstName, lastName, email],
  );
  return id;
}

async function seedOutboundActivity({
  id = "act_outbound_123",
  workspaceId = ACME,
  contactId = "cnt_sarah_connor",
  dealId = null,
  messageId = "outbound-123@tunaxa.com",
} = {}) {
  await query(
    `INSERT INTO activities (id, workspace_id, type, title, subject, description, direction, contact_id, deal_id, metadata)
     VALUES ($1, $2, 'email', $3, $3, $4, 'outbound', $5, $6, $7)`,
    [
      id,
      workspaceId,
      "Q3 Proposal",
      "Sent the Q3 proposal to the contact.",
      contactId,
      dealId,
      JSON.stringify({ direction: "outbound", messageId }),
    ],
  );
  return id;
}

function makePassword() {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync("test123", salt, 64).toString("hex")}`;
}

async function seedUserAndSession({ id = "usr_emailsync_admin", role = "admin", workspaceId = ACME } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  await mutateDb((db) => {
    db.users.push({
      id,
      name: id,
      email: `${id}@test.com`,
      password: makePassword(),
      role,
      workspaceId,
      createdAt: new Date().toISOString(),
    });
    db.sessions.push({
      token,
      userId: id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });
  return token;
}

const as = (token) => ({ Authorization: `Bearer ${token}` });

let app;

beforeAll(async () => {
  const mod = await import("../server.js");
  app = mod.app;
  await resetTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  await stopEmailSyncWorker();
});

afterAll(async () => {
  await stopEmailSyncWorker();
});

describe("parseRawEmail", () => {
  it("normalizes message ids, references and addresses from a MIME buffer", async () => {
    const parsed = await parseRawEmail(
      rawMessage({
        from: "Sarah Connor <Sarah.Connor@Cyberdyne.com>",
        messageId: "<msg-001@cyberdyne.com>",
        inReplyTo: "<outbound-123@tunaxa.com>",
        references: "<outbound-123@tunaxa.com> <mid-0@internal>",
      }),
    );

    expect(parsed.fromAddress).toBe(SARAH_EMAIL);
    expect(parsed.from).toEqual({ name: "Sarah Connor", address: SARAH_EMAIL });
    expect(parsed.messageId).toBe("msg-001@cyberdyne.com");
    expect(parsed.inReplyTo).toBe("outbound-123@tunaxa.com");
    expect(parsed.references).toEqual(["outbound-123@tunaxa.com", "mid-0@internal"]);
    expect(parsed.subject).toBe("Re: Q3 Proposal Discussion");
    expect(parsed.text).toContain("Thanks, this looks good.");
    expect(parsed.date).toBeInstanceOf(Date);
    expect(parsed.to).toEqual(["sales@acme.com"]);
  });

  it("strips angle brackets from a message id header", () => {
    expect(cleanMessageId("<abc-1@host>")).toBe("abc-1@host");
    expect(cleanMessageId("plain@host")).toBe("plain@host");
    expect(cleanMessageId(null)).toBeNull();
  });
});

describe("contact timeline matching", () => {
  it("records an inbound reply as an email activity on the matched contact's timeline", async () => {
    await seedContact();

    const parsed = await parseRawEmail(
      rawMessage({ messageId: "<inbound-001@cyberdyne.com>" }),
    );
    const result = await processInboundEmail(parsed, ACME);

    expect(result.status).toBe("created");
    expect(result.contact.id).toBe("cnt_sarah_connor");
    expect(result.dealId).toBeNull();
    expect(result.threadId).toBe("inbound-001@cyberdyne.com");

    const { rows } = await query("SELECT * FROM activities WHERE workspace_id = $1", [ACME]);
    expect(rows).toHaveLength(1);

    const activity = rows[0];
    expect(activity.type).toBe("email");
    expect(activity.contact_id).toBe("cnt_sarah_connor");
    expect(activity.record_id).toBe("cnt_sarah_connor");
    expect(activity.subject).toBe("Re: Q3 Proposal Discussion");
    expect(activity.description).toContain("Thanks, this looks good.");
    expect(activity.direction).toBe("inbound");
    expect(new Date(activity.created_at).toISOString()).toBe("2026-09-22T14:05:00.000Z");
    expect(activity.metadata.direction).toBe("inbound");
    expect(activity.metadata.messageId).toBe("inbound-001@cyberdyne.com");
    expect(activity.metadata.from).toBe(SARAH_EMAIL);
  });

  it("ingests an inbox end-to-end and flags matched messages as seen", async () => {
    await seedContact();

    const client = new InMemoryImapClient([
      { uid: 11, source: rawMessage({ messageId: "<inbound-011@cyberdyne.com>" }) },
      { uid: 12, source: rawMessage({ from: "Stranger <stranger@elsewhere.com>", messageId: "<inbound-012@elsewhere.com>" }) },
    ]);

    const summary = await syncInbox(
      { accountId: "acme-inbox" },
      { client, workspaceId: ACME, fetch: { seen: false } },
    );

    expect(summary.fetched).toBe(2);
    expect(summary.created).toBe(1);
    expect(summary.unmatched).toBe(1);
    expect(summary.seen).toBe(1);
    expect(summary.maxUid).toBe(12);

    // Matched message is read on the server; the stranger stays unread.
    expect(client.messages[0].flags).toContain("\\Seen");
    expect(client.messages[1].flags).not.toContain("\\Seen");

    const { rows } = await query("SELECT * FROM activities WHERE contact_id = $1", ["cnt_sarah_connor"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.uid).toBe(11);
    expect(rows[0].metadata.source).toBe("imap");
  });

  it("uses the HTML body when a message has no plaintext alternative", async () => {
    await seedContact();

    const source = Buffer.from(
      `From: Sarah <${SARAH_EMAIL}>\r\n` +
        `Subject: HTML only\r\n` +
        `MIME-Version: 1.0\r\n` +
        `Content-Type: text/html; charset=utf-8\r\n` +
        `\r\n` +
        `<html><body><p>Hello <b>world</b></p><script>alert(1)</script></body></html>`,
    );
    const result = await processInboundEmail(await parseRawEmail(source), ACME);

    expect(result.status).toBe("created");
    const { rows } = await query("SELECT description FROM activities WHERE workspace_id = $1", [ACME]);
    expect(rows[0].description).toContain("world");
    expect(rows[0].description).not.toContain("<script>");
    expect(rows[0].description).not.toContain("alert");
  });
});

describe("thread association", () => {
  it("links an inbound reply to the parent message activity and inherits its deal", async () => {
    await seedContact();
    await query(
      `INSERT INTO deals (id, workspace_id, title, stage, contact_id)
       VALUES ('deal_q3', $1, 'Q3 Proposal', 'Proposal', $2)`,
      [ACME, "cnt_sarah_connor"],
    );
    await seedOutboundActivity({ dealId: "deal_q3" });

    const parsed = await parseRawEmail(
      rawMessage({
        messageId: "<inbound-002@cyberdyne.com>",
        inReplyTo: "<outbound-123@tunaxa.com>",
      }),
    );
    const result = await processInboundEmail(parsed, ACME);

    expect(result.status).toBe("created");
    expect(result.threadId).toBe("outbound-123@tunaxa.com");
    expect(result.dealId).toBe("deal_q3");

    const { rows } = await query(
      `SELECT * FROM activities WHERE metadata->>'messageId' = $1`,
      ["inbound-002@cyberdyne.com"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].deal_id).toBe("deal_q3");
    expect(rows[0].metadata.threadId).toBe("outbound-123@tunaxa.com");
    expect(rows[0].metadata.inReplyTo).toBe("outbound-123@tunaxa.com");
  });

  it("associates a non-threaded reply with the contact's newest open deal", async () => {
    await seedContact();
    await query(
      `INSERT INTO deals (id, workspace_id, title, stage, contact_id)
       VALUES ('deal_closed', $1, 'Closed', 'won', $2), ('deal_open', $1, 'In negotiation', 'Negotiation', $2)`,
      [ACME, "cnt_sarah_connor"],
    );

    const parsed = await parseRawEmail(rawMessage({ messageId: "<inbound-003@cyberdyne.com>" }));
    const result = await processInboundEmail(parsed, ACME);

    expect(result.dealId).toBe("deal_open");
    const { rows } = await query("SELECT deal_id FROM activities WHERE workspace_id = $1", [ACME]);
    expect(rows[0].deal_id).toBe("deal_open");
  });
});

describe("deduplication", () => {
  it("creates exactly one activity for an identical payload ingested twice", async () => {
    await seedContact();

    const parsed = await parseRawEmail(rawMessage({ messageId: "<inbound-101@cyberdyne.com>" }));
    const first = await processInboundEmail(parsed, ACME);
    const second = await processInboundEmail(parsed, ACME);

    expect(first.status).toBe("created");
    expect(second.status).toBe("duplicate");
    const { rows } = await query(
      "SELECT COUNT(*)::int AS count FROM activities WHERE workspace_id = $1",
      [ACME],
    );
    expect(rows[0].count).toBe(1);
  });

  it("deduplicates the same message id across separate sync cycles", async () => {
    await seedContact();
    const source = rawMessage({ messageId: "<inbound-102@cyberdyne.com>" });

    const firstClient = new InMemoryImapClient([{ uid: 21, source }]);
    const first = await syncInbox(
      { accountId: "box-a" },
      { client: firstClient, workspaceId: ACME, fetch: { seen: false } },
    );
    const secondClient = new InMemoryImapClient([{ uid: 31, source }]);
    const second = await syncInbox(
      { accountId: "box-b" },
      { client: secondClient, workspaceId: ACME, fetch: { seen: false } },
    );

    expect(first.created).toBe(1);
    expect(second.duplicates).toBe(1);
    const { rows } = await query(
      "SELECT COUNT(*)::int AS count FROM activities WHERE workspace_id = $1",
      [ACME],
    );
    expect(rows[0].count).toBe(1);
  });
});

describe("multi-tenant workspace isolation", () => {
  it("never creates activities for a sender that only exists in another workspace", async () => {
    await seedContact({
      id: "cnt_alex_globex",
      workspaceId: GLOBEX,
      email: "alex@client.com",
      firstName: "Alex",
      lastName: "Mercer",
    });

    const parsed = await parseRawEmail(
      rawMessage({ from: "Alex <alex@client.com>", messageId: "<x-1@client.com>" }),
    );
    const result = await processInboundEmail(parsed, ACME);

    expect(result.status).toBe("unmatched");

    const globex = await query(
      "SELECT COUNT(*)::int AS count FROM activities WHERE workspace_id = $1",
      [GLOBEX],
    );
    expect(globex.rows[0].count).toBe(0);

    const acme = await query(
      `SELECT COUNT(*)::int AS count FROM activities
       WHERE workspace_id = $1 AND metadata->>'from' = $2`,
      [ACME, "alex@client.com"],
    );
    expect(acme.rows[0].count).toBe(0);
  });

  it("falls back to a workspace lead when the sender has no contact row", async () => {
    await query(
      `INSERT INTO leads (id, workspace_id, first_name, last_name, email)
       VALUES ('lead_jane_acme', $1, 'Jane', 'Doe', 'jane@client.com')`,
      [ACME],
    );

    const parsed = await parseRawEmail(
      rawMessage({ from: "Jane <jane@client.com>", messageId: "<lead-1@client.com>" }),
    );
    const result = await processInboundEmail(parsed, ACME);

    expect(result.status).toBe("created");
    const { rows } = await query(
      "SELECT * FROM activities WHERE record_id = $1 AND entity_type = 'lead'",
      ["lead_jane_acme"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].contact_id).toBeNull();
    expect(rows[0].contact).toBe("Jane Doe");
  });
});

describe("worker cycle", () => {
  it("runs a full cycle, advances the cursor, and reports status", async () => {
    await seedContact();
    await mutateDb((db) => {
      db.settings = {
        imap: {
          host: "imap.example.com",
          auth: { user: "sync@example.com", pass: "secret" },
        },
      };
    });

    const firstInbox = new InMemoryImapClient([
      { uid: 41, source: rawMessage({ messageId: "<work-041@cyberdyne.com>" }) },
    ]);
    const first = await runEmailSyncCycle({
      workspaceId: ACME,
      createClient: () => firstInbox,
    });

    expect(first.fetched).toBe(1);
    expect(first.created).toBe(1);
    expect(first.lastSeenUid).toBe(41);

    const status = await getEmailSyncStatus({ workspaceId: ACME });
    expect(status.configured).toBe(true);
    expect(status.processedCount).toBe(1);
    expect(status.lastSeenUid).toBe(41);
    expect(status.lastResult.created).toBe(1);
    expect(status.lastSyncedAt).toBeTruthy();

    // Second poll only pulls mail above the persisted cursor.
    const secondInbox = new InMemoryImapClient([
      { uid: 42, source: rawMessage({ messageId: "<work-042@cyberdyne.com>" }) },
    ]);
    const second = await runEmailSyncCycle({
      workspaceId: ACME,
      createClient: () => secondInbox,
    });
    expect(second.fetched).toBe(1);
    expect(second.created).toBe(1);
    expect(second.lastSeenUid).toBe(42);

    const afterSecond = await getEmailSyncStatus({ workspaceId: ACME });
    expect(afterSecond.processedCount).toBe(2);
  });

  it("skips cycles while another run on the same mailbox is in flight", async () => {
    await seedContact();
    await mutateDb((db) => {
      db.settings = {
        imap: {
          host: "imap.example.com",
          auth: { user: "sync@example.com", pass: "secret" },
        },
      };
    });

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const holdingClient = new InMemoryImapClient(
      [{ uid: 51, source: rawMessage({ messageId: "<concurrent-51@cyberdyne.com>" }) }],
      { fetchGate: gate },
    );

    const first = runEmailSyncCycle({
      workspaceId: ACME,
      createClient: () => holdingClient,
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await getEmailSyncStatus({ workspaceId: ACME });
      if (status.running) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const second = await runEmailSyncCycle({
      workspaceId: ACME,
      createClient: () => holdingClient,
    });
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("in-progress");

    release();
    await first;
  });

  it("starts and stops the periodic scheduler cleanly", async () => {
    startEmailSyncWorker({ intervalMs: 100_000 });
    expect(isEmailSyncWorkerRunning()).toBe(true);
    await stopEmailSyncWorker();
    expect(isEmailSyncWorkerRunning()).toBe(false);
  });
});

describe("management endpoints", () => {
  it("rejects unauthenticated trigger calls", async () => {
    const res = await request(app).post("/api/email-sync/trigger");
    expect(res.status).toBe(401);
  });

  it("returns a skipped cycle when no mailbox is configured", async () => {
    const token = await seedUserAndSession({ role: "member", id: "usr_emailsync_member" });
    const res = await request(app)
      .post("/api/email-sync/trigger")
      .set(as(token));
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
    expect(res.body.reason).toBe("not-configured");
  });

  it("blocks viewer-role users from triggering a sync", async () => {
    const token = await seedUserAndSession({ role: "viewer", id: "usr_emailsync_viewer" });
    const res = await request(app)
      .post("/api/email-sync/trigger")
      .set(as(token));
    expect(res.status).toBe(403);
  });

  it("reports status for an unconfigured account", async () => {
    const token = await seedUserAndSession({ role: "admin", id: "usr_emailsync_status" });
    const res = await request(app)
      .get("/api/email-sync/status")
      .set(as(token));
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.processedCount).toBe(0);
    expect(res.body.accountId).toBe("default");
  });
});