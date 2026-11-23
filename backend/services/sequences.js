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
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class SequenceEnrollmentError extends Error {
  constructor(message, { status = 500, code = 'SEQUENCE_ENROLLMENT_ERROR' } = {}) {
    super(message);
    this.name = 'SequenceEnrollmentError';
    this.status = status;
    this.code = code;
  }
}

function normalizeWorkspace(value) {
  return String(value ?? 'default');
}

function hasForbiddenKeys(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasForbiddenKeys);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || hasForbiddenKeys(value[key])) return true;
  }
  return false;
}

function validateIds(values, label, { min = 1, max = 100 } = {}) {
  if (!Array.isArray(values) || values.length < min || values.length > max) {
    throw new SequenceEnrollmentError(`${label} must contain between ${min} and ${max} items`, {
      status: 400,
      code: 'INVALID_IDS',
    });
  }
  const output = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      throw new SequenceEnrollmentError(`${label} must contain only strings`, {
        status: 400,
        code: 'INVALID_IDS',
      });
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 128 || hasForbiddenKeys({ [trimmed]: true })) {
      throw new SequenceEnrollmentError(`Invalid ${label} entry`, {
        status: 400,
        code: 'INVALID_IDS',
      });
    }
    if (!output.includes(trimmed)) output.push(trimmed);
  }
  if (!output.length) {
    throw new SequenceEnrollmentError(`${label} must not be empty`, {
      status: 400,
      code: 'INVALID_IDS',
    });
  }
  return output;
}

function recordMatchesWorkspace(record, workspaceId) {
  if (!record || typeof record !== 'object') return false;
  const actual = record.workspaceId ?? record.workspace_id;
  if (actual === undefined || actual === null || actual === '') {
    return normalizeWorkspace(workspaceId) === 'default';
  }
  return String(actual) === normalizeWorkspace(workspaceId);
}

async function findOwnedContact(contactId, workspaceId, db) {
  try {
    const fromPg = await repoFor('contacts').findById(contactId, workspaceId);
    if (fromPg) return fromPg;
  } catch {
    void 0;
  }
  const store = db || (await readDb());
  const rows = Array.isArray(store.contacts) ? store.contacts : [];
  return rows.find((row) => String(row?.id) === String(contactId) && recordMatchesWorkspace(row, workspaceId)) || null;
}

async function assertContactsOwned(contactIds, workspaceId, db) {
  const missing = [];
  for (const contactId of contactIds) {
    const owned = await findOwnedContact(contactId, workspaceId, db);
    if (!owned) missing.push(contactId);
  }
  if (missing.length) {
    throw new SequenceEnrollmentError('Contact not found', {
      status: 404,
      code: 'CONTACT_NOT_FOUND',
    });
  }
}

function resolveSequence(db, sequenceId, workspaceId) {
  const sequence = (db.sequences || []).find((item) => String(item.id) === String(sequenceId)) || null;
  if (!sequence) return null;
  if (!recordMatchesWorkspace(sequence, workspaceId)) return null;
  return sequence;
}

function stepDelayMs(step) {
  return (
    (Number(step?.delayDays) || 0) * MS_PER_DAY +
    (Number(step?.delayHours) || 0) * MS_PER_HOUR +
    (Number(step?.delayMinutes) || 0) * MS_PER_MINUTE
  );
}

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
  return { id: id('audit'), action, actor: actor || 'system', createdAt: now() };
}

function readEnrollments() {
  return readDb().then((db) => (Array.isArray(db.sequenceEnrollments) ? db.sequenceEnrollments : []));
}

export async function enrollContacts({ sequenceId, contactIds, workspaceId, userId = null }) {
  const ids = validateIds(contactIds, 'contactIds');
  const scope = normalizeWorkspace(workspaceId);
  if (typeof sequenceId !== 'string' || !sequenceId.trim() || sequenceId.length > 128) {
    throw new SequenceEnrollmentError('sequenceId is required', {
      status: 400,
      code: 'INVALID_SEQUENCE_ID',
    });
  }

  return mutateDb(async (db) => {
    const sequence = resolveSequence(db, sequenceId, scope);
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
    await assertContactsOwned(ids, scope, db);

    if (!Array.isArray(db.sequenceEnrollments)) db.sequenceEnrollments = [];
    const firstStepDelay = stepDelayMs(sequence.steps[0]);
    const created = [];
    const already = [];

    for (const contactId of ids) {
      const duplicate = db.sequenceEnrollments.some(
        (entry) =>
          normalizeWorkspace(entry.workspaceId) === scope &&
          String(entry.sequenceId) === String(sequence.id) &&
          String(entry.contactId) === String(contactId) &&
          (entry.status === ENROLLMENT_STATUS.ACTIVE || entry.status === ENROLLMENT_STATUS.PAUSED),
      );
      if (duplicate) {
        already.push(contactId);
        continue;
      }
      const stamp = now();
      const enrollment = {
        id: id('enr'),
        sequenceId: sequence.id,
        contactId,
        workspaceId: scope,
        status: ENROLLMENT_STATUS.ACTIVE,
        currentStep: 0,
        pausedReason: null,
        nextRunAt: new Date(Date.now() + firstStepDelay).toISOString(),
        metadata: { steps: [], enrolledAt: stamp },
        createdAt: stamp,
        updatedAt: stamp,
      };
      db.sequenceEnrollments.push(enrollment);
      created.push(enrollment);
    }

    if (created.length) {
      db.audit = Array.isArray(db.audit) ? db.audit : [];
      db.audit.unshift(auditEntry(`Enrolled ${created.length} contact(s) in sequence "${sequence.name}"`, userId));
    }
    return { enrolled: created.length, skipped: already.length, enrollments: created };
  });
}

export async function pauseEnrollmentsOnReply({ contactId, workspaceId, messageId = null }) {
  if (!contactId || typeof contactId !== 'string') return { paused: [], count: 0 };
  const scope = normalizeWorkspace(workspaceId);

  return mutateDb((db) => {
    if (!Array.isArray(db.sequenceEnrollments)) return { paused: [], count: 0 };
    const stamp = now();
    const paused = [];
    for (const enrollment of db.sequenceEnrollments) {
      if (
        normalizeWorkspace(enrollment.workspaceId) !== scope ||
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
        steps: Array.isArray(enrollment.metadata?.steps) ? enrollment.metadata.steps : [],
        pausedAt: stamp,
        pauseReason: PAUSE_REASONS.REPLY,
        ...(messageId ? { replyMessageId: messageId } : {}),
      };
      enrollment.updatedAt = stamp;
      paused.push(enrollment.id);
    }
    if (paused.length) {
      db.audit = Array.isArray(db.audit) ? db.audit : [];
      db.audit.unshift(auditEntry(`Sequence paused due to incoming reply (${paused.length} enrollment(s))`, 'imap'));
    }
    return { paused, count: paused.length };
  });
}

function mutateOwnedEnrollment(enrollmentId, workspaceId, mutate) {
  const scope = normalizeWorkspace(workspaceId);
  return mutateDb((db) => {
    const enrollment = (db.sequenceEnrollments || []).find(
      (entry) => String(entry.id) === String(enrollmentId) && normalizeWorkspace(entry.workspaceId) === scope,
    );
    if (!enrollment) {
      throw new SequenceEnrollmentError('Enrollment not found', {
        status: 404,
        code: 'ENROLLMENT_NOT_FOUND',
      });
    }
    const updated = mutate(enrollment, db);
    return updated === undefined ? enrollment : updated;
  });
}

export async function pauseEnrollment({ enrollmentId, workspaceId, reason = PAUSE_REASONS.MANUAL }) {
  return mutateOwnedEnrollment(enrollmentId, workspaceId, (enrollment) => {
    if (enrollment.status === ENROLLMENT_STATUS.PAUSED) return enrollment;
    if (enrollment.status !== ENROLLMENT_STATUS.ACTIVE) {
      throw new SequenceEnrollmentError(`Only active enrollments can be paused (is '${enrollment.status}')`, {
        status: 400,
        code: 'INVALID_STATE',
      });
    }
    const stamp = now();
    enrollment.status = ENROLLMENT_STATUS.PAUSED;
    enrollment.pausedReason = reason;
    enrollment.nextRunAt = null;
    enrollment.metadata = {
      ...(enrollment.metadata || {}),
      steps: Array.isArray(enrollment.metadata?.steps) ? enrollment.metadata.steps : [],
      pausedAt: stamp,
      pauseReason: reason,
    };
    enrollment.updatedAt = stamp;
    return enrollment;
  });
}

export async function resumeEnrollment({ enrollmentId, workspaceId }) {
  return mutateOwnedEnrollment(enrollmentId, workspaceId, (enrollment, db) => {
    if (enrollment.status !== ENROLLMENT_STATUS.PAUSED) {
      throw new SequenceEnrollmentError(`Only paused enrollments can be resumed (is '${enrollment.status}')`, {
        status: 400,
        code: 'INVALID_STATE',
      });
    }
    const stamp = now();
    const scope = normalizeWorkspace(workspaceId);
    const sequence = resolveSequence(db, enrollment.sequenceId, scope);
    const nextStep = Array.isArray(sequence?.steps) ? sequence.steps[enrollment.currentStep] : null;
    enrollment.status = ENROLLMENT_STATUS.ACTIVE;
    enrollment.pausedReason = null;
    enrollment.nextRunAt = new Date(Date.now() + (nextStep ? stepDelayMs(nextStep) : 0)).toISOString();
    enrollment.metadata = {
      ...(enrollment.metadata || {}),
      steps: Array.isArray(enrollment.metadata?.steps) ? enrollment.metadata.steps : [],
      pausedAt: enrollment.metadata?.pausedAt || null,
      resumedAt: stamp,
    };
    enrollment.updatedAt = stamp;
    return enrollment;
  });
}

export async function stopEnrollment({ enrollmentId, workspaceId }) {
  return mutateOwnedEnrollment(enrollmentId, workspaceId, (enrollment) => {
    if ([ENROLLMENT_STATUS.STOPPED, ENROLLMENT_STATUS.COMPLETED, ENROLLMENT_STATUS.REPLIED].includes(enrollment.status)) {
      throw new SequenceEnrollmentError(`Enrollment already ended ('${enrollment.status}')`, {
        status: 400,
        code: 'INVALID_STATE',
      });
    }
    const stamp = now();
    enrollment.status = ENROLLMENT_STATUS.STOPPED;
    enrollment.nextRunAt = null;
    enrollment.metadata = {
      ...(enrollment.metadata || {}),
      steps: Array.isArray(enrollment.metadata?.steps) ? enrollment.metadata.steps : [],
      stoppedAt: stamp,
    };
    enrollment.updatedAt = stamp;
    return enrollment;
  });
}

export async function listEnrollments({ sequenceId, workspaceId, status, page = 1, pageSize = 50 } = {}) {
  const enrollments = await readEnrollments();
  const scope = normalizeWorkspace(workspaceId);
  const filtered = enrollments.filter((entry) => {
    if (normalizeWorkspace(entry.workspaceId) !== scope) return false;
    if (sequenceId && String(entry.sequenceId) !== String(sequenceId)) return false;
    if (status && String(entry.status) !== String(status)) return false;
    return true;
  });
  filtered.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const size = Math.min(100, Math.max(1, Number(pageSize) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * size;
  return {
    data: filtered.slice(offset, offset + size),
    total: filtered.length,
    page: safePage,
    pageSize: size,
  };
}

export async function runDueSteps({ workspaceId = 'default', limit = 50 } = {}) {
  const summary = { processed: 0, dispatched: 0, completed: 0, skipped: 0, errors: 0 };
  const scope = normalizeWorkspace(workspaceId);
  const db = await readDb();
  const enrollments = (Array.isArray(db.sequenceEnrollments) ? db.sequenceEnrollments : [])
    .filter((entry) => normalizeWorkspace(entry.workspaceId) === scope);
  const nowMs = Date.now();
  const contactCache = new Map();
  const loadContact = async (contactId) => {
    if (contactCache.has(contactId)) return contactCache.get(contactId);
    let contact = null;
    try {
      contact = await repoFor('contacts').findById(contactId, scope);
    } catch {
      contact = null;
    }
    if (!contact && Array.isArray(db.contacts)) {
      const row = db.contacts.find(
        (entry) => String(entry?.id) === String(contactId) && recordMatchesWorkspace(entry, scope),
      );
      contact = row || null;
    }
    contactCache.set(contactId, contact);
    return contact;
  };

  for (const enrollment of enrollments.slice(0, Math.min(100, Math.max(1, Number(limit) || 50)))) {
    if (enrollment.status !== ENROLLMENT_STATUS.ACTIVE) {
      summary.skipped += 1;
      continue;
    }
    if (!enrollment.nextRunAt || new Date(enrollment.nextRunAt).getTime() > nowMs) {
      summary.skipped += 1;
      continue;
    }
    const sequence = resolveSequence(db, enrollment.sequenceId, scope);
    if (!sequence || !Array.isArray(sequence.steps)) {
      summary.skipped += 1;
      continue;
    }
    const step = sequence.steps[enrollment.currentStep];
    if (!step) {
      await mutateDb((draft) => {
        const live = (draft.sequenceEnrollments || []).find(
          (entry) => String(entry.id) === String(enrollment.id) && normalizeWorkspace(entry.workspaceId) === scope,
        );
        if (live) {
          live.status = ENROLLMENT_STATUS.COMPLETED;
          live.nextRunAt = null;
          live.updatedAt = now();
        }
      });
      summary.processed += 1;
      summary.completed += 1;
      continue;
    }

    const contact = await loadContact(enrollment.contactId);
    const contactRecord = contact || {};

    await mutateDb((draft) => {
      const live = (draft.sequenceEnrollments || []).find(
        (entry) => String(entry.id) === String(enrollment.id) && normalizeWorkspace(entry.workspaceId) === scope,
      );
      if (!live || live.status !== ENROLLMENT_STATUS.ACTIVE) return;
      const liveSequence = resolveSequence(draft, enrollment.sequenceId, scope);
      const liveStep = Array.isArray(liveSequence?.steps) ? liveSequence.steps[live.currentStep] : null;
      if (!liveStep) return;

      const stamp = now();
      draft.messages = Array.isArray(draft.messages) ? draft.messages : [];
      const message = {
        id: id('message'),
        channel: 'Email',
        to: mergeTemplate(liveStep.to || contactRecord.email || '', contactRecord),
        subject: mergeTemplate(liveStep.subject || '', contactRecord),
        body: mergeTemplate(liveStep.body || '', contactRecord),
        contact: contactRecord.firstName || contactRecord.first_name || contactRecord.name || contactRecord.email || enrollment.contactId,
        direction: 'Outbound',
        status: 'Queued',
        sequenceId: liveSequence.id,
        enrollmentId: live.id,
        source: 'sequence',
        createdAt: stamp,
        updatedAt: stamp,
      };
      draft.messages.unshift(message);

      if (liveStep.action === 'createTask') {
        draft.tasks = Array.isArray(draft.tasks) ? draft.tasks : [];
        draft.tasks.unshift({
          id: id('task'),
          title: mergeTemplate(liveStep.title || 'Follow up call', contactRecord),
          owner: contactRecord.owner || '',
          priority: liveStep.priority || 'Medium',
          status: 'Open',
          source: 'sequence',
          sequenceId: liveSequence.id,
          enrollmentId: live.id,
          createdAt: stamp,
          updatedAt: stamp,
        });
      }

      live.metadata = {
        ...(live.metadata || {}),
        steps: [
          ...(Array.isArray(live.metadata?.steps) ? live.metadata.steps : []),
          {
            stepId: liveStep.id,
            order: liveStep.order,
            action: liveStep.action || 'sendEmail',
            executedAt: stamp,
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
      live.updatedAt = stamp;
      summary.dispatched += 1;
    });
    summary.processed += 1;
  }
  return summary;
}
