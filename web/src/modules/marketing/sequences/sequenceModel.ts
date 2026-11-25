import { hasOwn, sanitizeFieldKey } from "../../../components/records/urlSecurity";
import type { Row } from "../../../components/records/types";

export type Sequence = Row & { name: string; enabled: boolean; steps: unknown; exitRules?: unknown };
export type StepDraft = {
  key: string;
  source: Record<string, unknown>;
  subject: string;
  body: string;
  delayDays: string;
  delayHours: string;
  delayMinutes: string;
  supported: boolean;
};
export type Enrollment = { id: string; sequenceId: string; contactId: string; status: string; currentStep: number; nextRunAt: string | null };
export type SequencePayload = { name: string; enabled: boolean; steps: Record<string, unknown>[]; exitRules?: unknown };
export type SequencePayloadOptions = { exitRules?: unknown };

export const enrollmentStates = ["active", "paused", "replied", "completed", "stopped"];
export const liveEnrollment = (row: Enrollment) => row.status === "active" || row.status === "paused";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SUPPORTED_ACTIONS = new Set([undefined, "email", "sendEmail"]);
const NAME_MAX = 100;
const STEPS_MAX = 20;
const SUBJECT_MAX = 200;
const BODY_MAX = 5000;
const DELAY_MAX: Record<"delayDays" | "delayHours" | "delayMinutes", number> = {
  delayDays: 365,
  delayHours: 23,
  delayMinutes: 59,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSupportedStep(step: unknown): boolean {
  return isRecord(step) && SUPPORTED_ACTIONS.has(step.action as string | undefined);
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!isRecord(value)) return value;
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!hasOwn(value, key) || FORBIDDEN_KEYS.has(key) || !sanitizeFieldKey(key)) continue;
    output[key] = sanitizeValue(value[key]);
  }
  return output;
}

export function parseSequences(value: unknown): Sequence[] {
  const rows = Array.isArray(value) ? value : isRecord(value) ? value.data : undefined;
  if (!Array.isArray(rows) || rows.some(row => !isRecord(row) || typeof row.id !== "string" || !row.id || typeof row.name !== "string")) throw new Error("Invalid sequence list response");
  return rows as Sequence[];
}

export function editableSteps(sequence: Sequence): boolean {
  const steps = sequence.steps;
  if (!Array.isArray(steps) || !steps.length || steps.length > STEPS_MAX) return false;
  if (!steps.some(isSupportedStep)) return false;
  return steps.every(step => {
    if (!isRecord(step)) return false;
    if (!isSupportedStep(step)) return true;
    return (step.subject === undefined || typeof step.subject === "string")
      && (step.body === undefined || typeof step.body === "string")
      && (step.to === undefined || typeof step.to === "string");
  });
}

export function draftStep(source: Record<string, unknown> = {}, key: string = crypto.randomUUID()): StepDraft {
  const record = isRecord(source) ? source : {};
  return {
    key,
    source: record,
    subject: typeof record.subject === "string" ? record.subject : "",
    body: typeof record.body === "string" ? record.body : "",
    delayDays: String(record.delayDays ?? 0),
    delayHours: String(record.delayHours ?? 0),
    delayMinutes: String(record.delayMinutes ?? 0),
    supported: isSupportedStep(record),
  };
}

export function sequencePayload(name: string, enabled: boolean, steps: StepDraft[], options: SequencePayloadOptions = {}): SequencePayload {
  const trimmedName = String(name ?? "").trim();
  if (!trimmedName || trimmedName.length > NAME_MAX) throw new Error(`Sequence name must be 1-${NAME_MAX} characters`);
  if (!Array.isArray(steps) || !steps.length || steps.length > STEPS_MAX) throw new Error(`Add between 1 and ${STEPS_MAX} steps`);

  const built = steps.map((step, order) => {
    const safe = sanitizeValue(step.source) as Record<string, unknown>;
    const id = typeof safe.id === "string" && safe.id ? safe.id : undefined;
    if (!step.supported) return { ...safe, id, order };

    const subject = String(step.subject ?? "").trim();
    const body = String(step.body ?? "").trim();
    if (!subject || subject.length > SUBJECT_MAX) throw new Error(`Step ${order + 1}: subject must be 1-${SUBJECT_MAX} characters`);
    if (!body || body.length > BODY_MAX) throw new Error(`Step ${order + 1}: message must be 1-${BODY_MAX} characters`);

    const delays = Object.fromEntries((["delayDays", "delayHours", "delayMinutes"] as const).map(field => {
      const raw = String(step[field] ?? "");
      const value = Number(raw);
      if (!raw.trim() || !Number.isSafeInteger(value) || value < 0 || value > DELAY_MAX[field]) {
        throw new Error(`Step ${order + 1}: enter a whole number from 0 to ${DELAY_MAX[field]} for ${field.replace("delay", "").toLowerCase()}`);
      }
      return [field, value];
    })) as Record<"delayDays" | "delayHours" | "delayMinutes", number>;

    const delayMs = delays.delayDays * 86400000 + delays.delayHours * 3600000 + delays.delayMinutes * 60000;
    if (!Number.isFinite(new Date(Date.now() + delayMs).getTime())) throw new Error(`Step ${order + 1}: this delay is too large to schedule`);

    return { ...safe, id, to: safe.to, action: safe.action || "sendEmail", order, subject, body, ...delays };
  });

  const payload: SequencePayload = { name: trimmedName, enabled, steps: built };
  if (options.exitRules !== undefined) payload.exitRules = sanitizeValue(options.exitRules);
  return payload;
}

export function assertSequenceSaved(value: unknown, payload: SequencePayload, existingId?: string): Sequence {
  const saved = value as Sequence;
  const steps = Array.isArray(saved?.steps) ? saved.steps : [];
  const invalid = !saved || typeof saved.id !== "string" || !saved.id
    || (existingId && saved.id !== existingId)
    || saved.name !== payload.name
    || saved.enabled !== payload.enabled
    || steps.length !== payload.steps.length
    || payload.steps.some((expected, index) => {
      const step = steps[index];
      if (!isRecord(step) || step.order !== index) return true;
      if (expected.id && step.id !== expected.id) return true;
      if (!isSupportedStep(expected)) return step.action !== expected.action;
      return step.subject !== expected.subject
        || step.body !== expected.body
        || step.action !== expected.action
        || step.to !== expected.to
        || Number(step.delayDays ?? 0) !== expected.delayDays
        || Number(step.delayHours ?? 0) !== expected.delayHours
        || Number(step.delayMinutes ?? 0) !== expected.delayMinutes;
    })
    || (payload.exitRules !== undefined && JSON.stringify(saved.exitRules) !== JSON.stringify(payload.exitRules));
  if (invalid) throw new Error("The server did not confirm the cadence. Reload the sequence list before saving again.");
  return saved;
}

export function parseEnrollmentPage(value: unknown): { data: Enrollment[]; total: number } {
  const page = value as { data: Enrollment[]; total: number };
  if (!page || !Array.isArray(page.data) || !Number.isSafeInteger(page.total) || page.total < page.data.length || page.data.some(row => !isRecord(row) || typeof row.id !== "string" || !row.id || typeof row.sequenceId !== "string" || typeof row.contactId !== "string" || !enrollmentStates.includes(row.status)
    || !Number.isSafeInteger(row.currentStep) || row.currentStep < 0 || (row.nextRunAt !== null && (typeof row.nextRunAt !== "string" || !Number.isFinite(Date.parse(row.nextRunAt)))))) throw new Error("Invalid enrollment response");
  return page;
}

export async function fetchEnrollments(sequenceId: string, get: (path: string) => Promise<unknown>): Promise<Enrollment[]> {
  const rows = new Map<string, Enrollment>();
  for (let page = 1; page <= 200; page++) {
    const response = parseEnrollmentPage(await get(`/sequences/${encodeURIComponent(sequenceId)}/enrollments?page=${page}&limit=50`));
    if (response.data.some(row => row.sequenceId !== sequenceId)) throw new Error("Enrollment list belongs to another sequence");
    const count = rows.size;
    response.data.forEach(row => rows.set(row.id, row));
    if (rows.size >= response.total) return [...rows.values()];
    if (rows.size === count) throw new Error("Enrollment list is incomplete. Refresh before continuing.");
  }
  throw new Error("Enrollment list is too large to verify. Contact your workspace administrator.");
}

export function enrollmentPayload(sequence: Sequence, contact: Row, existing: Enrollment[]) {
  if (sequence.enabled !== true || !editableSteps(sequence) || !(sequence.steps as unknown[]).length) throw new Error("Choose an enabled email cadence with at least one step");
  if (!contact.id || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contact.email || ""))) throw new Error("This contact needs a valid email address before enrollment");
  if (existing.some(row => row.sequenceId === sequence.id && row.contactId === contact.id && liveEnrollment(row))) throw new Error("This contact is already active or paused in that sequence");
  sequencePayload(sequence.name, true, (sequence.steps as Record<string, unknown>[]).map((step, index) => draftStep(step, String(index))));
  return { contactIds: [contact.id] };
}

export function assertEnrollmentSaved(value: unknown, sequenceId: string, contactId: string) {
  const result = value as { enrolled: number; skipped: number; enrollments: Enrollment[] };
  if (!result || !Number.isSafeInteger(result.enrolled) || !Number.isSafeInteger(result.skipped) || result.enrolled < 0 || result.skipped < 0 || result.enrolled + result.skipped !== 1 || !Array.isArray(result.enrollments)
    || (result.skipped === 1 && result.enrollments.length !== 0)
    || (result.enrolled === 1 && (result.enrollments.length !== 1 || result.enrollments[0].sequenceId !== sequenceId || result.enrollments[0].contactId !== contactId || !result.enrollments[0].id || result.enrollments[0].status !== "active"))) throw new Error("Enrollment could not be confirmed. Refresh its status before trying again.");
  return result.enrolled === 1 ? "Contact enrolled" : "Contact already enrolled; no duplicate was created";
}

export function legacyHasEnrollments(sequence: Sequence) {
  return Array.isArray(sequence.enrolled) && sequence.enrolled.some(row => !row.completedAt && !row.unenrolledAt && Number(row.currentStep ?? 0) < (Array.isArray(sequence.steps) ? sequence.steps.length : Infinity));
}

export function delayLabel(step: Record<string, unknown>): string {
  const parts = ([['delayDays', 'days'], ['delayHours', 'hours'], ['delayMinutes', 'minutes']] as const)
    .filter(([key]) => Number(step[key]) > 0).map(([key, label]) => `${step[key]} ${label}`);
  return parts.length ? `Wait ${parts.join(', ')}` : "No delay";
}
