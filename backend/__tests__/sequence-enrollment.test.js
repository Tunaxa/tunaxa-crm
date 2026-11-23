import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { resetTestDb, cleanupTestDb } from "./setup.js";
import { query } from "../db/pg.js";
import { readDb, mutateDb } from "../store.js";
import { processInboundEmail } from "../services/imapSync.js";
import { pauseEnrollmentsOnReply, runDueSteps } from "../services/sequences.js";
import * as sequenceService from "../services/sequences.js";

const ACME = "ws_acme";
const GLOBEX = "ws_globex";
const ACME_SEQ = "seq_acme";
const GLOBEX_SEQ = "seq_globex";
const CONTACT_A = "cnt_acme_a";
const CONTACT_B = "cnt_acme_b";
const CONTACT_G = "cnt_globex";
const EMAIL_A = "sarah.acme@cyberdyne.test";
const EMAIL_B = "kyle.acme@cyberdyne.test";
const EMAIL_G = "guest.globex@cyberdyne.test";

let pgReady = false;
try {
  await query("SELECT 1 FROM contacts LIMIT 1");
  pgReady = true;
} catch (error) {
  console.warn(`[sequence-enrollment] Postgres unavailable (${error.code || error.message}); skipping.`);
}

let app;
let tokens = {};

function as(who) {
  return { Authorization: `Bearer ${tokens[who] || who}` };
}

async function seedAuth() {
  const output = {};
  await mutateDb((db) => {
    const users = [
      ["admin", "usr_seq_admin", "admin@acme.test", "admin", ACME],
      ["member", "usr_seq_member", "member@acme.test", "member", ACME],
      ["viewer", "usr_seq_viewer", "viewer@acme.test", "viewer", ACME],
      ["globex", "usr_seq_globex", "admin@globex.test", "admin", GLOBEX],
    ];
    for (const [key, id, email, role, workspaceId] of users) {
      db.users.push({ id, name: email.split("@")[0], email, role, workspaceId, createdAt: new Date().toISOString() });
      const token = crypto.randomBytes(32).toString("hex");
      db.sessions.push({ token, userId: id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      output[key] = token;
    }
  });
  return output;
}

async function seedSequence(id, workspaceId) {
  await mutateDb((db) => {
    db.sequences = db.sequences || [];
    db.sequences.push({
      id,
      name: `Cadence ${workspaceId}`,
      enabled: true,
      workspaceId,
      steps: [
        { id: "step_1", order: 0, action: "sendEmail", delayDays: 0, to: "{{email}}", subject: "Intro {{firstName}}", body: "Hi" },
        { id: "step_2", order: 1, action: "sendEmail", delayDays: 2, subject: "Follow up" },
      ],
      exitRules: [],
      enrolled: [],
      createdAt: "2026-09-01T00:00:00.000Z",
      createdBy: "test-admin",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
  });
}

async function insertContact(id, workspaceId, email, first = "Sarah") {
  await query(
    "INSERT INTO contacts (id, workspace_id, first_name, last_name, email) VALUES ($1, $2, $3, $4, $5)",
    [id, workspaceId, first, "Connor", email],
  );
}

async function enroll(token, sequenceId, contactIds) {
  return request(app)
    .post(`/api/sequences/${sequenceId}/enroll`)
    .set(as(token))
    .send({ contactIds });
}

async function listEnrollments(token, sequenceId) {
  return request(app)
    .get(`/api/sequences/${sequenceId}/enrollments`)
    .set(as(token));
}

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
}, 30000);

beforeEach(async () => {
  await resetTestDb();
  tokens = await seedAuth();
  await seedSequence(ACME_SEQ, ACME);
  await seedSequence(GLOBEX_SEQ, GLOBEX);
  if (pgReady) {
    await insertContact(CONTACT_A, ACME, EMAIL_A);
    await insertContact(CONTACT_B, ACME, EMAIL_B, "Kyle");
    await insertContact(CONTACT_G, GLOBEX, EMAIL_G, "Guest");
  }
});

afterAll(() => cleanupTestDb());

describe.skipIf(!pgReady)("sequence enrollment API", () => {
  it("enrolls tenant-owned contacts with active state and nextRunAt scheduling", async () => {
    const res = await enroll(tokens.admin, ACME_SEQ, [CONTACT_A, CONTACT_B]);
    expect(res.status).toBe(201);
    expect(res.body.enrolled).toBe(2);
    expect(res.body.skipped).toBe(0);
    for (const enrollment of res.body.enrollments) {
      expect(enrollment.status).toBe("active");
      expect(enrollment.workspaceId).toBe(ACME);
      expect(enrollment.currentStep).toBe(0);
      expect(new Date(enrollment.nextRunAt).getTime()).toBeGreaterThan(0);
    }
    const db = await readDb();
    expect(db.sequenceEnrollments).toHaveLength(2);
  });

  it("suppresses duplicate active and paused enrollments idempotently", async () => {
    await enroll(tokens.admin, ACME_SEQ, [CONTACT_A, CONTACT_B]);
    const duplicate = await enroll(tokens.admin, ACME_SEQ, [CONTACT_A, CONTACT_B]);
    expect(duplicate.status).toBe(201);
    expect(duplicate.body.enrolled).toBe(0);
    expect(duplicate.body.skipped).toBe(2);

    const listing = await listEnrollments(tokens.admin, ACME_SEQ);
    await request(app).post(`/api/sequences/enrollments/${listing.body.data[0].id}/pause`).set(as(tokens.admin));
    const afterPause = await enroll(tokens.admin, ACME_SEQ, [CONTACT_A, CONTACT_B]);
    expect(afterPause.body.enrolled).toBe(0);
    expect(afterPause.body.skipped).toBe(2);
  });

  it("manages pause, resume and stop with terminal-state guards", async () => {
    await enroll(tokens.admin, ACME_SEQ, [CONTACT_A]);
    const listing = await listEnrollments(tokens.admin, ACME_SEQ);
    const enrollmentId = listing.body.data[0].id;

    const paused = await request(app).post(`/api/sequences/enrollments/${enrollmentId}/pause`).set(as(tokens.admin));
    expect(paused.status).toBe(200);
    expect(paused.body.enrollment.status).toBe("paused");
    expect(paused.body.enrollment.nextRunAt).toBeNull();

    const resumed = await request(app).post(`/api/sequences/enrollments/${enrollmentId}/resume`).set(as(tokens.member));
    expect(resumed.status).toBe(200);
    expect(resumed.body.enrollment.status).toBe("active");

    const stopped = await request(app).post(`/api/sequences/enrollments/${enrollmentId}/stop`).set(as(tokens.admin));
    expect(stopped.status).toBe(200);
    expect(stopped.body.enrollment.status).toBe("stopped");

    const terminalResume = await request(app).post(`/api/sequences/enrollments/${enrollmentId}/resume`).set(as(tokens.admin));
    expect(terminalResume.status).toBe(400);

    await enroll(tokens.admin, ACME_SEQ, [CONTACT_B]);
    const second = await listEnrollments(tokens.admin, ACME_SEQ);
    const repliedId = second.body.data.find((entry) => entry.contactId === CONTACT_B).id;
    await pauseEnrollmentsOnReply({ contactId: CONTACT_B, workspaceId: ACME, messageId: "terminal@test" });
    const repliedResume = await request(app).post(`/api/sequences/enrollments/${repliedId}/resume`).set(as(tokens.admin));
    expect(repliedResume.status).toBe(400);
  });

  it("rejects enrolling a contact owned by another tenant with 404 and zero writes", async () => {
    const res = await enroll(tokens.admin, ACME_SEQ, [CONTACT_G]);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CONTACT_NOT_FOUND");
    const db = await readDb();
    expect(db.sequenceEnrollments.some((entry) => entry.contactId === CONTACT_G)).toBe(false);
  });

  it("prevents cross-tenant listing, pause, resume and stop of enrollments", async () => {
    await enroll(tokens.admin, ACME_SEQ, [CONTACT_A]);
    const own = await listEnrollments(tokens.admin, ACME_SEQ);
    expect(own.body.total).toBe(1);
    const enrollmentId = own.body.data[0].id;

    const foreignList = await listEnrollments(tokens.globex, ACME_SEQ);
    expect(foreignList.status).toBe(200);
    expect(foreignList.body.total).toBe(0);

    for (const action of ["pause", "resume", "stop"]) {
      const res = await request(app).post(`/api/sequences/enrollments/${enrollmentId}/${action}`).set(as(tokens.globex));
      expect(res.status).toBe(404);
    }
    const db = await readDb();
    expect(db.sequenceEnrollments[0].status).toBe("active");
  });

  it("auto-pauses active cadences on inbound reply without touching terminal or foreign rows", async () => {
    await enroll(tokens.admin, ACME_SEQ, [CONTACT_A]);
    await mutateDb((db) => {
      const base = db.sequenceEnrollments[0];
      db.sequenceEnrollments.push({ ...base, id: "enr_paused", status: "paused", nextRunAt: null });
      db.sequenceEnrollments.push({ ...base, id: "enr_completed", status: "completed", nextRunAt: null });
      db.sequenceEnrollments.push({ ...base, id: "enr_foreign", workspaceId: GLOBEX, status: "active" });
    });

    const result = await processInboundEmail({
      fromAddress: EMAIL_A,
      to: "sales@acme.test",
      subject: "Re: Proposal",
      messageId: "<reply-seq-01@cyberdyne.test>",
      inReplyTo: null,
      references: [],
      text: "Yes, let us move forward.",
      date: new Date("2026-09-22T14:05:00.000Z"),
    }, ACME);
    expect(result.status).toBe("created");

    const db = await readDb();
    const replied = db.sequenceEnrollments.find((entry) => entry.id !== "enr_paused" && entry.id !== "enr_completed" && entry.id !== "enr_foreign");
    expect(replied.status).toBe("replied");
    expect(replied.nextRunAt).toBeNull();
    expect(replied.metadata.pauseReason).toBe("reply_received");
    expect(replied.metadata.replyMessageId).toBe("reply-seq-01@cyberdyne.test");
    expect(db.sequenceEnrollments.find((entry) => entry.id === "enr_paused").status).toBe("paused");
    expect(db.sequenceEnrollments.find((entry) => entry.id === "enr_completed").status).toBe("completed");
    expect(db.sequenceEnrollments.find((entry) => entry.id === "enr_foreign").status).toBe("active");
  });

  it("dispatches only active due steps and skips replied enrollments", async () => {
    await enroll(tokens.admin, ACME_SEQ, [CONTACT_A, CONTACT_B]);
    await pauseEnrollmentsOnReply({ contactId: CONTACT_B, workspaceId: ACME });
    await mutateDb((db) => {
      for (const entry of db.sequenceEnrollments) {
        entry.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      }
    });

    const summary = await runDueSteps({ workspaceId: ACME });
    expect(summary.dispatched).toBe(1);
    expect(summary.skipped).toBe(1);
    const db = await readDb();
    const active = db.sequenceEnrollments.find((entry) => entry.contactId === CONTACT_A);
    const replied = db.sequenceEnrollments.find((entry) => entry.contactId === CONTACT_B);
    expect(active.currentStep).toBe(1);
    expect(active.status).toBe("active");
    expect(replied.currentStep).toBe(0);
    expect(replied.status).toBe("replied");
    expect(db.messages.some((message) => message.enrollmentId === replied.id)).toBe(false);
  });

  it("enforces authentication, role and field-mask permissions", async () => {
    const unauthenticated = await request(app).post(`/api/sequences/${ACME_SEQ}/enroll`).send({ contactIds: [CONTACT_A] });
    expect(unauthenticated.status).toBe(401);

    const viewer = await enroll(tokens.viewer, ACME_SEQ, [CONTACT_A]);
    expect(viewer.status).toBe(403);

    await mutateDb((db) => {
      db.fieldPermissions = { sequence: { member: { visible: [], hidden: ["contactIds"] } } };
    });
    const masked = await enroll(tokens.member, ACME_SEQ, [CONTACT_A]);
    expect(masked.status).toBe(403);
    expect(masked.body.maskedFields).toContain("contactIds");
  });

  it("rejects invalid, oversized, unknown-key and prototype-polluting bodies", async () => {
    const invalid = [
      { contactIds: [] },
      { contactIds: Array.from({ length: 101 }, (_, index) => `cnt_${index}`) },
      { contactIds: [CONTACT_A], unknown: true },
      { contactIds: [CONTACT_A], recordIds: [CONTACT_B] },
      JSON.parse(`{"contactIds":["${CONTACT_A}"],"__proto__":{"polluted":true}}`),
      JSON.parse(`{"contactIds":["${CONTACT_A}"],"constructor":{"polluted":true}}`),
      JSON.parse(`{"contactIds":["${CONTACT_A}"],"prototype":{"polluted":true}}`),
    ];
    for (const body of invalid) {
      const res = await request(app).post(`/api/sequences/${ACME_SEQ}/enroll`).set(as(tokens.admin)).send(body);
      expect(res.status).toBe(400);
    }
    const db = await readDb();
    expect(db.sequenceEnrollments).toHaveLength(0);
  });

  it("rejects invalid list query parameters", async () => {
    const badStatus = await request(app).get(`/api/sequences/${ACME_SEQ}/enrollments?status=bogus`).set(as(tokens.admin));
    expect(badStatus.status).toBe(400);
    const badLimit = await request(app).get(`/api/sequences/${ACME_SEQ}/enrollments?limit=101`).set(as(tokens.admin));
    expect(badLimit.status).toBe(400);
    const unknown = await request(app).get(`/api/sequences/${ACME_SEQ}/enrollments?extra=1`).set(as(tokens.admin));
    expect(unknown.status).toBe(400);
  });

  it("returns a sanitized 500 response on unexpected enrollment errors", async () => {
    const spy = vi.spyOn(sequenceService, "enrollContacts").mockImplementation(() => {
      throw new Error("secret-sql-detail");
    });
    try {
      const res = await enroll(tokens.admin, ACME_SEQ, [CONTACT_A]);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Internal server error" });
      expect(JSON.stringify(res.body)).not.toContain("secret-sql-detail");
    } finally {
      spy.mockRestore();
    }
  });
});
