import type { Row } from "../../../components/records/types";

export type Sequence = Row & { name: string; enabled: boolean; steps: unknown };
export type StepDraft = {
  key: string; source: Record<string, unknown>; subject: string; body: string;
  delayDays: string; delayHours: string; delayMinutes: string;
};
export type Enrollment = { id: string; sequenceId: string; contactId: string; status: string; currentStep: number; nextRunAt: string | null };
export const enrollmentStates = ["active", "paused", "replied", "completed", "stopped"];
export const liveEnrollment = (row: Enrollment) => row.status === "active" || row.status === "paused";

export function parseSequences(value: unknown): Sequence[] {
  const rows = Array.isArray(value) ? value : (value as { data?: unknown })?.data;
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== "string" || !row.id || typeof row.name !== "string")) throw new Error("Invalid sequence list response");
  return rows as Sequence[];
}
export function editableSteps(sequence: Sequence): boolean {
  return Array.isArray(sequence.steps) && sequence.steps.every(step => step && typeof step === "object" && !Array.isArray(step)
    && [undefined, "email", "sendEmail"].includes(step.action)
    && (step.subject === undefined || typeof step.subject === "string") && (step.body === undefined || typeof step.body === "string")
    && (step.to === undefined || typeof step.to === "string"));
}
export function draftStep(source: Record<string, unknown> = {}, key: string = crypto.randomUUID()): StepDraft {
  return { key, source, subject: String(source.subject ?? ""), body: String(source.body ?? ""),
    delayDays: String(source.delayDays ?? 0), delayHours: String(source.delayHours ?? 0), delayMinutes: String(source.delayMinutes ?? 0) };
}
export function sequencePayload(name: string, enabled: boolean, steps: StepDraft[]) {
  if (!name.trim()) throw new Error("Sequence name is required");
  if (!steps.length) throw new Error("Add at least one email step");
  return { name: name.trim(), enabled, steps: steps.map((step, order) => {
    if (![undefined, "email", "sendEmail"].includes(step.source.action as string | undefined)) throw new Error("This builder supports email steps only");
    if (!step.subject.trim() || !step.body.trim()) throw new Error(`Step ${order + 1} needs a subject and message`);
    const delays = Object.fromEntries((["delayDays", "delayHours", "delayMinutes"] as const).map(key => {
      const value = Number(step[key]);
      const maximum = key === "delayHours" ? 23 : key === "delayMinutes" ? 59 : Number.MAX_SAFE_INTEGER;
      if (!step[key].trim() || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`Step ${order + 1}: enter a valid whole number for ${key.replace("delay", "").toLowerCase()}`);
      return [key, value];
    })) as Record<"delayDays" | "delayHours" | "delayMinutes", number>;
    const delayMs = delays.delayDays * 86400000 + delays.delayHours * 3600000 + delays.delayMinutes * 60000;
    if (!Number.isFinite(new Date(Date.now() + delayMs).getTime())) throw new Error(`Step ${order + 1}: this delay is too large to schedule`);
    return { ...step.source, id: typeof step.source.id === "string" ? step.source.id : undefined, to: step.source.to, action: step.source.action || "sendEmail", order, subject: step.subject.trim(), body: step.body, ...delays };
  }) };
}
export function assertSequenceSaved(value: unknown, payload: ReturnType<typeof sequencePayload>, existingId?: string): Sequence {
  const saved = value as Sequence;
  if (!saved || typeof saved.id !== "string" || !saved.id || (existingId && saved.id !== existingId) || saved.name !== payload.name || saved.enabled !== payload.enabled || !Array.isArray(saved.steps) || saved.steps.length !== payload.steps.length
    || saved.steps.some((step, index) => {
      const expected = payload.steps[index];
      return !step || step.subject !== expected.subject || step.body !== expected.body || step.action !== expected.action || step.to !== expected.to || step.order !== index
        || Number(step.delayDays ?? 0) !== expected.delayDays || Number(step.delayHours ?? 0) !== expected.delayHours || Number(step.delayMinutes ?? 0) !== expected.delayMinutes
        || (expected.id && step.id !== expected.id);
    })) throw new Error("The server did not confirm the cadence. Reload the sequence list before saving again.");
  return saved;
}
export function parseEnrollmentPage(value: unknown): { data: Enrollment[]; total: number } {
  const page = value as { data: Enrollment[]; total: number };
  if (!page || !Array.isArray(page.data) || !Number.isSafeInteger(page.total) || page.total < page.data.length || page.data.some(row => !row || typeof row.id !== "string" || !row.id || typeof row.sequenceId !== "string" || typeof row.contactId !== "string" || !enrollmentStates.includes(row.status)
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
