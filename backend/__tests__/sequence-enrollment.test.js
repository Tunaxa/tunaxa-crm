// Sequence Enrollment API & reply auto-pause.
//
// Two layers:
//   1. Engine layer (pure JSON-store unit tests, no database): enrollContacts,
//      pauseEnrollmentsOnReply, pause/resume/stop, listEnrollments and the
//      runDueSteps step runner. Postgres-backed contact lookups inside the
//      runner are best-effort and degrade to null, so this block never needs a
//      live database.
//   2. API + IMAP layer (skipped when Postgres is unreachable): the enroll /
//      enrollments / pause / resume / stop endpoints behind auth, and an
//      end-to-end check that processInboundEmail() flips a matched contact's
//      active cadences to 'replied' so the runner can no longer dispatch.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { resetTestDb, cleanupTestDb } from "./setup.js";
import { readDb, mutateDb } from "../store.js";
import { query } from "../db/pg.js";
import { processInboundEmail } from "../services/imapSync.js";
import {
  enrollContacts,
  pauseEnrollmentsOnReply,
  pauseEnrollment,
  resumeEnrollment,
  stopEnrollment,
  listEnrollments,
  runDueSteps,
  ENROLLMENT_STATUS,
  PAUSE_REASONS,
  SequenceEnrollmentError,
} from "../services/sequences.js";

const ACME = "ws_acme";
const GLOBEX = "ws_globex";
const CONTACT_A = "cnt_seq_a";
const CONTACT_B = "cnt_seq_b";
const SARAH_EMAIL = "sarah.connor@cyberdyne.com";

let pgReady = false;
try {
  await query("SELECT 1 FROM deals LIMIT 1");
  pgReady = true;
} catch (error) {
  console.warn(
    `[sequence-enrollment] Postgres is unreachable (${error.code || error.message}) - skipping database and HTTP assertions. Set PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE and re-run.`,
  );
}

async function seedSequence(id = "seq_cadence", steps) {
  const defaultSteps = [
    { id: "step_1", order: 0, action: "sendEmail", delayDays: 0, to: "{{email}}", subject: "Intro {{firstName}}", body: "Hi" },
    { id: "step_2", order: 1, action: "sendEmail", delayDays: 2, subject: "Follow up" },
    { id: "step_3", order: 2, action: "sendEmail", delayDays: 4, subject: "Last chance" },
  ];
  await mutateDb((db) => {
    db.sequences = db.sequences || [];
    db.sequences.push({
      id,
      name: "Growth cadence",
      enabled: true,
      steps: steps || defaultSteps,
      exitRules: [],
      enrolled: [],
      createdAt: "2026-09-01T00:00:00.000Z",
      createdBy: "test-admin",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
  });
  return id;
}

const withinMs = (iso, minMs, maxMs) => {
  const t = new Date(iso).getTime();
  return t >= minMs && t <= maxMs;
};

// ===========================================================================
describe("Sequence enrollment engine (JSON store)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("enrolls contacts into an active cadence with an immediate first run", async () => {
    await seedSequence();
    const result = await enrollContacts({
      sequenceId: "seq_cadence",
      contactIds: [CONTACT_A, CONTACT_B],
      workspaceId: ACME,
      userId: "usr_test",
    });

    expect(result.enrolled).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.enrollments).toHaveLength(2);
    for (const enrollment of result.enrollments) {
      expect(enrollment.id).toMatch(/^enr_/);
      expect(enrollment.sequenceId).toBe("seq_cadence");
      expect(enrollment.workspaceId).toBe(ACME);
      expect(enrollment.status).toBe(ENROLLMENT_STATUS.ACTIVE);
      expect(enrollment.currentStep).toBe(0);
      expect(enrollment.pausedReason).toBeNull();
      expect(enrollment.nextRunAt).toBeTruthy();
      expect(enrollment.metadata.steps).toEqual([]);
      expect(withinMs(enrollment.nextRunAt, Date.now() - 5000, Date.now() + 5000)).toBe(true);
    }
  });

  it("schedules nextRunAt from the first step's delay", async () => {
    await seedSequence("seq_delayed", [{ id: "step_d1", order: 0, action: "sendEmail", delayDays: 2, subject: "Wait two days" }]);
    await enrollContacts({ sequenceId: "seq_delayed", contactIds: [CONTACT_A], workspaceId: ACME });
    const db = await readDb();
    const enrollment = db.sequenceEnrollments[0];
    const expected = Date.now() + 2 * 86400000;
    expect(withinMs(enrollment.nextRunAt, expected - 5000, expected + 5000)).toBe(true);
  });

  it("rejects unknown sequences (404) and step-less sequences (400)", async () => {
    await expect(
      enrollContacts({ sequenceId: "seq_missing", contactIds: [CONTACT_A], workspaceId: ACME }),
    ).rejects.toMatchObject({ status: 404, code: "SEQUENCE_NOT_FOUND" });

    await seedSequence();
    await mutateDb((db) => {
      const seq = db.sequences.find((s) => s.id === "seq_cadence");
      seq.steps = [];
    });
    await expect(
      enrollContacts({ sequenceId: "seq_cadence", contactIds: [CONTACT_A], workspaceId: ACME }),
    ).rejects.toMatchObject({ status: 400, code: "EMPTY_SEQUENCE" });
  });

  it("skips duplicate active enrollments for the same contact + sequence", async () => {
    await seedSequence();
    await enrollContacts({ sequenceId: "seq_cadence", contactIds: [CONTACT_A, CONTACT_B], workspaceId: ACME });
    const second = await enrollContacts({
      sequenceId: "seq_cadence",
      contactIds: [CONTACT_A, CONTACT_B, "cnt_seq_c"],
      workspaceId: ACME,
    });
    expect(second.enrolled).toBe(1);
    expect(second.skipped).toBe(2);
    const db = await readDb();
    expect(db.sequenceEnrollments.filter((e) => e.sequenceId === "seq_cadence")).toHaveLength(3);
  });

  it("creates independent enrollments per sequence (multi-cadence)", async () => {
    await seedSequence("seq_cadence");
    await seedSequence("seq_second", [{ id: "step_s1", order: 0, action: "sendEmail", delayDays: 0, subject: "Hi" }]);
    await enrollContacts({ sequenceId: "seq_cadence", contactIds: [CONTACT_A], workspaceId: ACME });
    await enrollContacts({ sequenceId: "seq_second", contactIds: [CONTACT_A], workspaceId: ACME });
    const db = await readDb();
    const forA = db.sequenceEnrollments.filter((e) => e.contactId === CONTACT_A);
    expect(forA).toHaveLength(2);
    expect(new Set(forA.map((e) => e.sequenceId))).toEqual(new Set(["seq_cadence", "seq_second"]));
  });

  it("an inbound reply pauses every active cadence for that contact", async () => {
    await seedSequence("seq_cadence");
    await seedSequence("seq_second", [{ id: "step_s1", order: 0, action: "sendEmail", delayDays: 0, subject: "Hi" }]);
    await enrollContacts({ sequenceId: "seq_cadence", contactIds: [CONTACT_A], workspaceId: ACME });
    await enrollContacts({ sequenceId: "seq_second", contactIds: [CONTACT_A], workspaceId: ACME });

    const paused = await pauseEnrollmentsOnReply({ contactId: CONTACT_A, workspaceId: ACME, messageId: "<r1@x>" });
    expect(paused.count).toBe(2);
    expect(paused.paused).toHaveLength(2);

    const db = await readDb();
    const affected = db.sequenceEnrollments.filter((e) => e.contactId === CONTACT_A);
    expect(affected).toHaveLength(2);
    for (const enrollment of affected) {
      expect(enrollment.status).toBe(ENROLLMENT_STATUS.REPLIED);
      expect(enrollment.pausedReason).toBe(PAUSE_REASONS.REPLY);
      expect(enrollment.nextRunAt).toBeNull();
      expect(enrollment.metadata.pauseReason).toBe(PAUSE_REASONS.REPLY);
      expect(enrollment.metadata.replyMessageId).toBe("<r1@x>");
      expect(enrollment.metadata.pausedAt).toBeTruthy();
    }
  });

  it("reply pause is scoped to workspace + contact and no-ops when nothing matches", async () => {
    await seedSequence();
    await Promise.all([
      enrollContacts({ sequenceId: "seq_cadence", contactIds: [CONTACT_A], workspaceId: ACME }),
      enrollContacts({ sequenceId: "seq_cadence", contactIds: [CONTACT_B], workspaceId: GLOBEX }),
    ]);

    const paused = await pauseEnrollmentsOnReply({ contactId: CONTACT_B, workspaceId: GLOBEX });
    expect(paused.count).toBe(1);

    const db = await readDb();
    const acmeEnrollment = db.sequenceEnrollments.find((e) => e.contactId === CONTACT_A && e.workspaceId === ACME);
    const globexEnrollment = db.sequenceEnrollments.find((e) => e.contactId === CONTACT_B && e.workspaceId === GLOBEX);
    expect(acmeEnrollment.status).toBe(ENROLLMENT_STATUS.ACTIVE);
    expect(globexEnrollment.status).toBe(ENROLLMENT_STATUS.REPLIED);

    const nothing = await pauseEnrollmentsOnReply({ contactId: "cnt_absent", workspaceId: ACME });
    expect(nothing).toEqual({ paused: [], count: 0 });
  });

  it("runner dispatches only active + due enrollments (paused/replied/stopped dispatch nothing)", async () => {
    await seedSequence();
    await enrollContacts({ sequenceId: "seq_cadence", contactIds: [CONTACT_A], workspaceId: ACME });
    await enrollContacts({ sequenceId: "seq_cadence", contactIds: [CONTACT_B], workspaceId: ACME });
    await pauseEnrollmentsOnReply({ contactId: CONTACT_B, workspaceId: ACME });

    await mutateDb((db) => {
      // Force everyone to an "overdue" next run to prove state gates first.
      for (const enrollment of db.sequenceEnrollments) {
        enrollment.nextRunAt = new Date(Date.now() - 60000).toISOString();
      }
    });

    const summary = await runDueSteps({ workspaceId: ACME });
    expect(summary.dispatched).toBe(1);
    expect(summary.processed).toBe(1);
    expect(summary.skipped).toBe(1);

    const db = await readDb();
    const a = db.sequenceEnrollments.find((e) => e.contactId === CONTACT_A);
    const b = db.sequenceEnrollments.find((e) => e.contactId === CONTACT_B);
    expect(a.status).toBe(ENROLLMENT_STATUS.ACTIVE);
    expect(a.currentStep).toBe(1);
    expect(a.metadata.steps).toHaveLength(1);
    expect(a.metadata.steps[0].messageId).toMatch(/^message_/);
    expect(a.metadata.steps[0].status).toBe("dispatched");
    expect(b.status).toBe(ENROLLMENT_STATUS.REPLIED);
    expect(b.currentStep).toBe(0);

    const message = db.messages.find((m) => m.enrollmentId === a.id);
    expect(message).toBeTruthy();
    expect(message.sequenceId).toBe("seq_cadence");
    expect(message.status).toBe("Queued");

    const noMessageForB = db.messages.some((m) => m.enrollmentId === b.id);
    expect(noMessageForB).toBe(false);
  });

  it("runner advances a due step and closes the cadence after the last step", async () => {
    await seedSequence();
    await mutateDb((db) => {
      db.sequences.find((s) => s.id === "seq_cadence").steps = [
        { id: "step_only", order: 0, action: "sendEmail", delayDays: 0, subject: "Only touch" },
      ];
    });
    await enrollContacts({ sequenceId: "seq_cadence", contactIds: [CONTACT_A], workspaceId: ACME });

    const summary = await runDueSteps({ workspaceId: ACME });
    expect(summary.dispatched).toBe(1);
    expect(summary.completed).toBe(1);

    const db = await readDb();
    const enrollment = db.sequenceEnrollments[0];
    expect(enrollment.status).toBe(ENROLLMENT_STATUS.COMPLETED);
    expect(enrollment.currentStep).toBe(1);
    expect(enrollment.nextRunAt).toBeNull();
    expect(db.messages).toHaveLength(1);
  });

  it("manual pause/resume/stop lifecycle with state guards", async () => {
    await seedSequence();
    const { enrollments } = await enrollContacts({ sequenceId: "seq_cadence", contactIds: [CONTACT_A], workspaceId: ACME });
    const id = enrollments[0].id;

    await pauseEnrollment({ enrollmentId: id, workspaceId: ACME, userId: "usr_test" });
    let db = await readDb();
    let enrollment = db.sequenceEnrollments[0];
    expect(enrollment.status).toBe(ENROLLMENT_STATUS.PAUSED);
    expect(enrollment.pausedReason).toBe(PAUSE_REASONS.MANUAL);
    expect(enrollment.nextRunAt).toBeNull();

    // Pausing an already-paused enrollment is idempotent.
    await pauseEnrollment({ enrollmentId: id, workspaceId: ACME });
    db = await readDb();
    expect(db.sequenceEnrollments[0].status).toBe(ENROLLMENT_STATUS.PAUSED);

    await resumeEnrollment({ enrollmentId: id, workspaceId: ACME, userId: "usr_test" });
    db = await readDb();
    enrollment = db.sequenceEnrollments[0];
    expect(enrollment.status).toBe(ENROLLMENT_STATUS.ACTIVE);
    expect(enrollment.pausedReason).toBeNull();
    expect(enrollment.nextRunAt).toBeTruthy();
    expect(enrollment.metadata.resumedAt).toBeTruthy();

    // Resuming a non-paused enrollment is rejected.
    await expect(resumeEnrollment({ enrollmentId: id, workspaceId: ACME })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_STATE",
    });

    await stopEnrollment({ enrollmentId: id, workspaceId: ACME, userId: "usr_test" });
    db = await readDb();
    enrollment = db.sequenceEnrollments[0];
    expect(enrollment.status).toBe(ENROLLMENT_STATUS.STOPPED);
    expect(enrollment.nextRunAt).toBeNull();

    await expect(stopEnrollment({ enrollmentId: id, workspaceId: ACME })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_STATE",
    });

    // Halt/control of a foreign workspace enrollment is a 404.
    await expect(pauseEnrollment({ enrollmentId: id, workspaceId: GLOBEX })).rejects.toMatchObject({
      status: 404,
      code: "ENROLLMENT_NOT_FOUND",
    });
  });

  it("listEnrollments is workspace-scoped and filters by status", async () => {
    await seedSequence();
    await enrollContacts({ sequenceId: "seq_cadence", contactIds: [CONTACT_A], workspaceId: ACME });
    await enrollContacts({ sequenceId: "seq_cadence", contactIds: [CONTACT_B], workspaceId: GLOBEX });
    await pauseEnrollmentsOnReply({ contactId: CONTACT_B, workspaceId: GLOBEX });

    const acme = await listEnrollments({ sequenceId: "seq_cadence", workspaceId: ACME });
    expect(acme.total).toBe(1);

    const globexReplied = await listEnrollments({ sequenceId: "seq_cadence", workspaceId: GLOBEX, status: ENROLLMENT_STATUS.REPLIED });
    expect(globexReplied.total).toBe(1);
    expect(globexReplied.data[0].contactId).toBe(CONTACT_B);

    const globexActive = await listEnrollments({ sequenceId: "seq_cadence", workspaceId: GLOBEX, status: ENROLLMENT_STATUS.ACTIVE });
    expect(globexActive.total).toBe(0);
  });
});

// ===========================================================================
describe.skipIf(!pgReady)("Sequence enrollment API & IMAP reply auto-pause", () => {
  function makePassword() {
    const salt = crypto.randomBytes(16).toString("hex");
    return `${salt}:${crypto.scryptSync("test123", salt, 64).toString("hex")}`;
  }

  async function seedSession(userId) {
    const token = crypto.randomBytes(32).toString("hex");
    await mutateDb((db) => {
      db.sessions.push({
        token,
        userId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    });
    return token;
  }

  async function seedAuth() {
    await mutateDb((db) => {
      const users = [
        ["usr_seq_admin", "seqadmin@test.com", "admin", ACME],
        ["usr_seq_member", "seqmember@test.com", "member", ACME],
        ["usr_seq_globex", "seqglobex@test.com", "admin", GLOBEX],
      ];
      for (const [id, email, role, workspaceId] of users) {
        db.users.push({
          id,
          name: email.split("@")[0],
          email,
          password: makePassword(),
          role,
          workspaceId,
          createdAt: new Date().toISOString(),
        });
      }
    });
    tokens.admin = await seedSession("usr_seq_admin");
    tokens.member = await seedSession("usr_seq_member");
    tokens.globex = await seedSession("usr_seq_globex");
  }

  async function seedPostgresContact({ id = CONTACT_A, workspaceId = ACME, email = SARAH_EMAIL } = {}) {
    await query(
      `INSERT INTO contacts (id, workspace_id, first_name, last_name, email)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, workspaceId, "Sarah", "Connor", email],
    );
  }

  const tokens = { admin: "", member: "", globex: "" };
  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

  let app;

  beforeAll(async () => {
    await resetTestDb();
    const mod = await import("../server.js");
    app = mod.app;
  });

  beforeEach(async () => {
    await resetTestDb();
    await seedAuth();
    await seedSequence();
  });

  afterAll(() => cleanupTestDb());

  it("POST /api/sequences/:id/enroll with contactIds creates first-class enrollments", async () => {
    await seedPostgresContact();
    await seedPostgresContact({ id: CONTACT_B, email: "kyle.reece@cyberdyne.com" });

    const res = await request(app)
      .post("/api/sequences/seq_cadence/enroll")
      .set(as("admin"))
      .send({ contactIds: [CONTACT_A, CONTACT_B] });

    expect(res.status).toBe(201);
    expect(res.body.enrolled).toBe(2);
    expect(res.body.skipped).toBe(0);
    expect(res.body.enrollments).toHaveLength(2);
    const db = await readDb();
    const enrollments = db.sequenceEnrollments.filter((e) => e.sequenceId === "seq_cadence");
    expect(enrollments).toHaveLength(2);
    for (const enrollment of enrollments) {
      expect(enrollment.status).toBe(ENROLLMENT_STATUS.ACTIVE);
      expect(enrollment.workspaceId).toBe(ACME);
    }
  });

  it("GET /api/sequences/:id/enrollments lists and filters by status", async () => {
    await seedPostgresContact();
    await request(app).post("/api/sequences/seq_cadence/enroll").set(as("admin")).send({ contactIds: [CONTACT_A] });

    const all = await request(app).get("/api/sequences/seq_cadence/enrollments").set(as("admin"));
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(1);
    expect(all.body.data[0].sequenceId).toBe("seq_cadence");

    const enrollmentId = all.body.data[0].id;
    await request(app).post(`/api/sequences/enrollments/${enrollmentId}/pause`).set(as("admin"));

    const paused = await request(app)
      .get("/api/sequences/seq_cadence/enrollments")
      .query({ status: ENROLLMENT_STATUS.PAUSED })
      .set(as("admin"));
    expect(paused.body.total).toBe(1);
    expect(paused.body.data[0].status).toBe(ENROLLMENT_STATUS.PAUSED);

    const active = await request(app)
      .get("/api/sequences/seq_cadence/enrollments")
      .query({ status: ENROLLMENT_STATUS.ACTIVE })
      .set(as("admin"));
    expect(active.body.total).toBe(0);
  });

  it("pause/resume/stop endpoints manage an enrollment; a foreign workspace gets 404", async () => {
    await seedPostgresContact();
    await request(app).post("/api/sequences/seq_cadence/enroll").set(as("admin")).send({ contactIds: [CONTACT_A] });

    const listing = await request(app).get("/api/sequences/seq_cadence/enrollments").set(as("admin"));
    const enrollmentId = listing.body.data[0].id;

    const foreign = await request(app).post(`/api/sequences/enrollments/${enrollmentId}/pause`).set(as("globex"));
    expect(foreign.status).toBe(404);

    const paused = await request(app).post(`/api/sequences/enrollments/${enrollmentId}/pause`).set(as("admin"));
    expect(paused.status).toBe(200);
    expect(paused.body.enrollment.status).toBe(ENROLLMENT_STATUS.PAUSED);

    const resumed = await request(app).post(`/api/sequences/enrollments/${enrollmentId}/resume`).set(as("member"));
    expect(resumed.status).toBe(200);
    expect(resumed.body.enrollment.status).toBe(ENROLLMENT_STATUS.ACTIVE);
    expect(resumed.body.enrollment.nextRunAt).toBeTruthy();

    const stopped = await request(app).post(`/api/sequences/enrollments/${enrollmentId}/stop`).set(as("admin"));
    expect(stopped.status).toBe(200);
    expect(stopped.body.enrollment.status).toBe(ENROLLMENT_STATUS.STOPPED);

    const db = await readDb();
    const enrollment = db.sequenceEnrollments.find((e) => e.id === enrollmentId);
    expect(enrollment.nextRunAt).toBeNull();
  });

  it("processInboundEmail pauses the contact's active enrollment on a reply", async () => {
    await seedPostgresContact();
    await enrollContacts({ sequenceId: "seq_cadence", contactIds: [CONTACT_A], workspaceId: ACME });

    const parsed = {
      fromAddress: SARAH_EMAIL,
      to: "sales@acme.com",
      subject: "Re: Q3 Proposal Discussion",
      messageId: "<reply-seq-001@cyberdyne.com>",
      inReplyTo: null,
      references: [],
      text: "Yes, let's move forward.",
      date: new Date("2026-09-22T14:05:00.000Z"),
    };

    const result = await processInboundEmail(parsed, ACME);
    expect(result.status).toBe("created");
    expect(result.contact.id).toBe(CONTACT_A);
    expect(result.activity.contact_id).toBe(CONTACT_A);

    const db = await readDb();
    const enrollment = db.sequenceEnrollments.find((e) => e.contactId === CONTACT_A);
    expect(enrollment.status).toBe(ENROLLMENT_STATUS.REPLIED);
    expect(enrollment.pausedReason).toBe(PAUSE_REASONS.REPLY);
    expect(enrollment.nextRunAt).toBeNull();
    expect(enrollment.metadata.replyMessageId).toBe("reply-seq-001@cyberdyne.com");
  });

  it("a replied enrollment never dispatches through the runner", async () => {
    await seedPostgresContact();
    await enrollContacts({ sequenceId: "seq_cadence", contactIds: [CONTACT_A], workspaceId: ACME });
    await pauseEnrollmentsOnReply({ contactId: CONTACT_A, workspaceId: ACME });

    await mutateDb((db) => {
      db.sequenceEnrollments[0].nextRunAt = new Date(Date.now() - 60000).toISOString();
    });

    const summary = await runDueSteps({ workspaceId: ACME });
    expect(summary.dispatched).toBe(0);
    expect(summary.skipped).toBe(1);

    const db = await readDb();
    expect(db.messages).toHaveLength(0);
  });
});

// Keep the error type import observed so the suite fails loudly if the
// constructor contract ever drifts.
describe("SequenceEnrollmentError contract", () => {
  it("defaults to a 500 status", () => {
    const error = new SequenceEnrollmentError("boom");
    expect(error.status).toBe(500);
    expect(error.code).toBe("SEQUENCE_ENROLLMENT_ERROR");
    expect(error.name).toBe("SequenceEnrollmentError");
  });
});