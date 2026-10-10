// Sequence cadence enrollment engine & reply auto-pause.
//
// Enrollments are first-class records in the JSON store (db.sequenceEnrollments)
// rather than an array nested inside the sequence, so one contact can run
// several cadences at once and a single inbound reply can halt every active
// cadence for that contact with one filter.
//
// Lifecycle:   active --(manual pause)--> paused --(resume)--> active
//              active --(inbound reply)--> replied  (terminal: nextRunAt = null)
//              active --(manual stop)----> stopped  (terminal)
//              active --(last step)------> completed
// Only 'active' enrollments are ever scheduled; every other state has
// next_run_at cleared, so the step runner physically cannot dispatch for them.
//
// Tenant isolation: every enrollment records the workspace it was created in,
// and every read/write is scoped to that workspace. Sequences created before
// workspace scoping existed carry no workspaceId; those are treated as
// first-come (the enrolling caller claims them for its own workspace), while a
// sequence that DOES declare a workspace is only visible to that workspace.

import { readDb, mutateDb } from '../store.js';
import { id, now } from '../helpers.js';
import { repoFor } from '../db/repositories/index.js';

export const ENROLLMENT_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  REPLIED: 'replied',
  STOPPED: 'stopped',
};

export const PAUSE_REASONS = {
  REPLY: 'reply_received',
  MANUAL: 'manual',
  UNSUBSCRIBED: 'unsubscribed',
};

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Error carrying the HTTP status a route should answer with. */
export class SequenceEnrollmentError extends Error {
  constructor(message, { status = 500, code = 'SEQUENCE_ENROLLMENT_ERROR' } = {}) {
    super(message);
    this.name = 'SequenceEnrollmentError';
    this.status = status;
    this.code = code;
  }
}

/**
 * A sequence is visible to a workspace when it either carries no workspaceId
 * (legacy, unscoped) or the id matches the caller's.
 */
function resolveSequence(db, sequenceId, workspaceId) {
  const sequence = (db.sequences || []).find((s) => s.id === sequenceId) || null;
  if (!sequence) return null;
  if (sequence.workspaceId && String(sequence.workspaceId) !== String(workspaceId)) return null;
  return sequence;
}

function stepDelayMs(step) {
  return (
    (Number(step?.delayDays) || 0) * MS_PER_DAY +
    (Number(step?.delayHours) || 0) * MS_PER_HOUR +
    (Number(step?.delayMinutes) || 0) * MS_PER_MINUTE
  );
}

function stamp() {
  return now();
}

/** Minimal {{ field }} merge for step templates, mirrors routes/sequences.js. */
function mergeTemplate(template, record) {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = key.split('.').reduce(
      (obj, part) => (obj && typeof obj === 'object' ? obj[part] : undefined),
      record,
    );
    return value === undefined || value === null ? '' : String(value);
  });
}

function auditEntry(action, actor) {
  return { id: id('audit'), action, actor: actor || 'system', createdAt: stamp() };
}

async function readEnrollments() {
  const db = await readDb();
  return db.sequenceEnrollments || [];
}

/**
 * Enroll contacts into a sequence cadence.
 *
 * Guardrails: the sequence must exist and be visible to `workspaceId` and carry
 * at least one step; a contact that already has an ACTIVE or PAUSED enrollment
 * in the same sequence is skipped rather than duplicated. The first step's
 * delay config decides the initial `nextRunAt`.
 *
 * @returns {Promise<{ enrolled: number, skipped: number, enrollments: object[] }>}
 */
export async function enrollContacts({ sequenceId, contactIds, workspaceId, userId = null }) {
  const ids = Array.isArray(contactIds) ? [...new Set(contactIds.map((c) => String(c).trim()).filter(Boolean))] : [];
  if (!ids.length) {
    throw new SequenceEnrollmentError('contactIds must be a non-empty array', {
      status: 400,
      code: 'INVALID_CONTACT_IDS',
    });
  }
  if (!sequenceId) {
    throw new SequenceEnrollmentError('sequenceId is required', {
      status: 400,
      code: 'INVALID_SEQUENCE_ID',
    });
  }

  return mutateDb((db) => {
    const sequence = resolveSequence(db, sequenceId, workspaceId);
    if (!sequence) {
      throw new SequenceEnrollmentError('Sequence not found', {
        status: 404,
        code: 'SEQUENCE_NOT_FOUND',
      });
    }
    if (!Array.isArray(sequence.steps) || sequence.steps.length === 0) {
      throw new SequenceEnrollmentError('Sequence must contain at least one step', {
        status: 400,
        code: 'EMPTY_SEQUENCE',
      });
    }

    if (!db.sequenceEnrollments) db.sequenceEnrollments = [];
    const firstStepDelay = stepDelayMs(sequence.steps[0]);
    const created = [];
    const already = [];

    for (const contactId of ids) {
      const duplicate = db.sequenceEnrollments.some(
        (e) =>
          e.sequenceId === sequenceId &&
          e.contactId === contactId &&
          (e.status === ENROLLMENT_STATUS.ACTIVE || e.status === ENROLLMENT_STATUS.PAUSED),
      );
      if (duplicate) {
        already.push(contactId);
        continue;
      }
      const createdAtStamp = stamp();
      const enrollment = {
        id: id('enr'),
        sequenceId: sequence.id,
        contactId,
        workspaceId: String(workspaceId || 'default'),
        status: ENROLLMENT_STATUS.ACTIVE,
        currentStep: 0,
        pausedReason: null,
        nextRunAt: new Date(Date.now() + firstStepDelay).toISOString(),
        metadata: {
          steps: [],
          enrolledAt: createdAtStamp,
        },
        createdAt: createdAtStamp,
        updatedAt: createdAtStamp,
      };
      db.sequenceEnrollments.push(enrollment);
      created.push(enrollment);
    }

    db.audit = db.audit || [];
    db.audit.unshift(
      auditEntry(`Enrolled ${created.length} contact(s) in sequence "${sequence.name}"`, userId),
    );

    return { enrolled: created.length, skipped: already.length, enrollments: created };
  });
}

/**
 * Halt every active cadence for one contact after an inbound reply.
 *
 * Equivalent to `UPDATE sequence_enrollments SET status='replied',
 * paused_reason='reply_received', next_run_at=NULL WHERE workspace_id=$1 AND
 * contact_id=$2 AND status='active'`. Runs as a single atomic mutation and
 * returns without throwing when no active enrollment matches.
 *
 * @returns {Promise<{ paused: string[], count: number }>}
 */
export async function pauseEnrollmentsOnReply({ contactId, workspaceId, messageId = null }) {
  if (!contactId) return { paused: [], count: 0 };

  return mutateDb((db) => {
    if (!Array.isArray(db.sequenceEnrollments)) return { paused: [], count: 0 };
    const stampNow = stamp();
    const paused = [];
    for (const enrollment of db.sequenceEnrollments) {
      if (
        String(enrollment.workspaceId) !== String(workspaceId || 'default') ||
        String(enrollment.contactId) !== String(contactId) ||
        enrollment.status !== ENROLLMENT_STATUS.ACTIVE
      ) {
        continue;
      }
      enrollment.status = ENROLLMENT_STATUS.REPLIED;
      enrollment.pausedReason = PAUSE_REASONS.REPLY;
      enrollment.nextRunAt = null;
      enrollment.metadata = {
        ...(enrollment.metadata || {}),
        steps: enrollment.metadata?.steps || [],
        pausedAt: stampNow,
        pauseReason: PAUSE_REASONS.REPLY,
      };
      if (messageId) enrollment.metadata.replyMessageId = messageId;
      enrollment.updatedAt = stampNow;
      paused.push(enrollment.id);
    }

    if (paused.length > 0) {
      db.audit = db.audit || [];
      db.audit.unshift(
        auditEntry(`Sequence paused due to incoming reply (${paused.length} enrollment(s))`, 'imap'),
      );
    }
    return { paused, count: paused.length };
  });
}

async function mutateOwnedEnrollment(enrollmentId, workspaceId, mutate) {
  return mutateDb((db) => {
    const enrollment = (db.sequenceEnrollments || []).find(
      (e) => String(e.id) === String(enrollmentId) && String(e.workspaceId) === String(workspaceId || 'default'),
    );
    if (!enrollment) {
      throw new SequenceEnrollmentError('Enrollment not found', {
        status: 404,
        code: 'ENROLLMENT_NOT_FOUND',
      });
    }
    const updated = mutate(enrollment, db);
    if (updated !== undefined) return updated;
    return enrollment;
  });
}

/** Manual pause: active -> paused, next run cleared. Idempotent when already paused. */
export async function pauseEnrollment({ enrollmentId, workspaceId, reason = PAUSE_REASONS.MANUAL }) {
  return mutateOwnedEnrollment(enrollmentId, workspaceId, (enrollment) => {
    const stampNow = stamp();
    if (enrollment.status === ENROLLMENT_STATUS.PAUSED) return enrollment;
    if (enrollment.status !== ENROLLMENT_STATUS.ACTIVE) {
      throw new SequenceEnrollmentError(`Only active enrollments can be paused (is '${enrollment.status}')`, {
        status: 400,
        code: 'INVALID_STATE',
      });
    }
    enrollment.status = ENROLLMENT_STATUS.PAUSED;
    enrollment.pausedReason = reason;
    enrollment.nextRunAt = null;
    enrollment.metadata = {
      ...(enrollment.metadata || {}),
      steps: enrollment.metadata?.steps || [],
      pausedAt: stampNow,
      pauseReason: reason,
    };
    enrollment.updatedAt = stampNow;
    return enrollment;
  });
}

/** Resume: paused -> active, rescheduling the next pending step from now. */
export async function resumeEnrollment({ enrollmentId, workspaceId }) {
  return mutateOwnedEnrollment(enrollmentId, workspaceId, (enrollment, db) => {
    if (enrollment.status !== ENROLLMENT_STATUS.PAUSED) {
      throw new SequenceEnrollmentError(`Only paused enrollments can be resumed (is '${enrollment.status}')`, {
        status: 400,
        code: 'INVALID_STATE',
      });
    }
    const stampNow = stamp();
    const sequence = resolveSequence(db, enrollment.sequenceId, workspaceId);
    const nextStep =
      sequence && Array.isArray(sequence.steps) ? sequence.steps[enrollment.currentStep] : null;
    const nextDelay = nextStep ? stepDelayMs(nextStep) : 0;
    enrollment.status = ENROLLMENT_STATUS.ACTIVE;
    enrollment.pausedReason = null;
    enrollment.nextRunAt = new Date(Date.now() + nextDelay).toISOString();
    enrollment.metadata = {
      ...(enrollment.metadata || {}),
      steps: enrollment.metadata?.steps || [],
      pausedAt: enrollment.metadata?.pausedAt || null,
      resumedAt: stampNow,
    };
    enrollment.updatedAt = stampNow;
    return enrollment;
  });
}

/** Permanent halt: any non-terminal state -> stopped, next run cleared. */
export async function stopEnrollment({ enrollmentId, workspaceId }) {
  return mutateOwnedEnrollment(enrollmentId, workspaceId, (enrollment) => {
    if (enrollment.status === ENROLLMENT_STATUS.STOPPED ||
        enrollment.status === ENROLLMENT_STATUS.COMPLETED ||
        enrollment.status === ENROLLMENT_STATUS.REPLIED) {
      throw new SequenceEnrollmentError(`Enrollment already ended ('${enrollment.status}')`, {
        status: 400,
        code: 'INVALID_STATE',
      });
    }
    const stampNow = stamp();
    enrollment.status = ENROLLMENT_STATUS.STOPPED;
    enrollment.nextRunAt = null;
    enrollment.metadata = {
      ...(enrollment.metadata || {}),
      steps: enrollment.metadata?.steps || [],
      stoppedAt: stampNow,
    };
    enrollment.updatedAt = stampNow;
    return enrollment;
  });
}

/**
 * List enrollments visible to a workspace, newest first, with optional
 * sequence / status filters and offset pagination.
 */
export async function listEnrollments({ sequenceId, workspaceId, status, page = 1, pageSize = 50 } = {}) {
  const enrollments = await readEnrollments();
  const scope = String(workspaceId || 'default');
  const filtered = enrollments.filter((e) => {
    if (String(e.workspaceId) !== scope) return false;
    if (sequenceId && String(e.sequenceId) !== String(sequenceId)) return false;
    if (status && String(e.status) !== String(status)) return false;
    return true;
  });
  filtered.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const size = Math.max(1, Number(pageSize) || 50);
  const offset = Math.max(0, (Number(page) || 1) - 1) * size;
  return {
    data: filtered.slice(offset, offset + size),
    total: filtered.length,
    page: Math.max(1, Number(page) || 1),
    pageSize: size,
  };
}

/**
 * Dispatch due sequence steps for a workspace.
 *
 * Processes enrollments that are 'active', whose nextRunAt has passed, and
 * which still have a step left. Every other state is skipped by construction -
 * a replied/paused/stopped/completed enrollment can never dispatch here no
 * matter how stale its nextRunAt is. Email steps are queued as messages;
 * tasks are created for createTask steps. The real SMTP send is left to the
 * existing message pathway.
 */
export async function runDueSteps({ workspaceId = 'default', limit = 50 } = {}) {
  const summary = { processed: 0, dispatched: 0, completed: 0, skipped: 0, errors: 0 };
  const db = await readDb();
  const enrollments = (db.sequenceEnrollments || []).filter(
    (e) => String(e.workspaceId) === String(workspaceId || 'default'),
  );
  const nowMs = Date.now();

  // Read each contact once, best-effort; the runner stays usable when the
  // contact lives in Postgres that is unreachable or was never seeded.
  const contactCache = new Map();
  const loadContact = async (contactId) => {
    if (contactCache.has(contactId)) return contactCache.get(contactId);
    let contact = null;
    try {
      contact = await repoFor('contacts').findById(contactId, workspaceId);
    } catch {
      contact = null;
    }
    contactCache.set(contactId, contact);
    return contact;
  };

  for (const enrollment of enrollments.slice(0, limit)) {
    if (enrollment.status !== ENROLLMENT_STATUS.ACTIVE) {
      summary.skipped += 1;
      continue;
    }
    if (!enrollment.nextRunAt || new Date(enrollment.nextRunAt).getTime() > nowMs) {
      summary.skipped += 1;
      continue;
    }
    const sequence = resolveSequence(db, enrollment.sequenceId, workspaceId);
    if (!sequence) {
      summary.skipped += 1;
      continue;
    }
    const step = Array.isArray(sequence.steps) ? sequence.steps[enrollment.currentStep] : null;
    if (!step) {
      // Ran off the end: nothing left to do, close the enrollment.
      await mutateDb((d) => {
        const live = (d.sequenceEnrollments || []).find((e) => e.id === enrollment.id);
        if (live) {
          live.status = ENROLLMENT_STATUS.COMPLETED;
          live.nextRunAt = null;
          live.updatedAt = stamp();
        }
      });
      summary.processed += 1;
      summary.completed += 1;
      continue;
    }

    const contact = await loadContact(enrollment.contactId);
    const contactRecord = contact || {};

    await mutateDb((d) => {
      const live = (d.sequenceEnrollments || []).find((e) => e.id === enrollment.id);
      if (!live || live.status !== ENROLLMENT_STATUS.ACTIVE) return;
      const liveSequence = resolveSequence(d, enrollment.sequenceId, workspaceId);
      if (!liveSequence) return;
      const liveStep = Array.isArray(liveSequence.steps) ? liveSequence.steps[live.currentStep] : null;
      if (!liveStep) return;

      const createdAtStamp = stamp();
      d.messages = d.messages || [];
      const message = {
        id: id('message'),
        channel: 'Email',
        to: mergeTemplate(liveStep.to || contactRecord?.email || '', contactRecord),
        subject: mergeTemplate(liveStep.subject || '', contactRecord),
        body: mergeTemplate(liveStep.body || '', contactRecord),
        contact: contactRecord?.firstName || contactRecord?.name || contactRecord?.email || enrollment.contactId,
        direction: 'Outbound',
        status: 'Queued',
        sequenceId: liveSequence.id,
        enrollmentId: live.id,
        source: 'sequence',
        createdAt: createdAtStamp,
        updatedAt: createdAtStamp,
      };
      d.messages.unshift(message);

      if (liveStep.action === 'createTask') {
        d.tasks = d.tasks || [];
        d.tasks.unshift({
          id: id('task'),
          title: mergeTemplate(liveStep.title || 'Follow up call', contactRecord),
          owner: contactRecord?.owner || '',
          priority: liveStep.priority || 'Medium',
          status: 'Open',
          source: 'sequence',
          sequenceId: liveSequence.id,
          enrollmentId: live.id,
          createdAt: createdAtStamp,
          updatedAt: createdAtStamp,
        });
      }

      live.metadata = {
        ...(live.metadata || {}),
        steps: [
          ...(live.metadata?.steps || []),
          {
            stepId: liveStep.id,
            order: liveStep.order,
            action: liveStep.action || 'sendEmail',
            executedAt: createdAtStamp,
            messageId: message.id,
            status: 'dispatched',
          },
        ],
      };
      live.currentStep += 1;

      const nextStep = Array.isArray(liveSequence.steps) ? liveSequence.steps[live.currentStep] : null;
      if (!nextStep) {
        live.status = ENROLLMENT_STATUS.COMPLETED;
        live.nextRunAt = null;
        summary.completed += 1;
      } else {
        live.nextRunAt = new Date(Date.now() + stepDelayMs(nextStep)).toISOString();
      }
      live.updatedAt = createdAtStamp;
      summary.dispatched += 1;
    });
    summary.processed += 1;
  }
  return summary;
}