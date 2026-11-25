import { describe, expect, it, vi } from "vitest";
import { assertEnrollmentSaved, assertSequenceSaved, delayLabel, draftStep, editableSteps, enrollmentPayload, fetchEnrollments, legacyHasEnrollments, parseEnrollmentPage, parseSequences, sequencePayload, type Enrollment, type Sequence } from "./sequenceModel";

const emailStep = { id: "step_a", action: "sendEmail", subject: "Hello {{firstName}}", body: "Message", delayDays: 0, order: 0, extra: "preserve", to: "{{email}}" };
const legacyStep = { id: "legacy_a", action: "createTask", title: "Legacy task", extra: "preserved" };
const sequence: Sequence = { id: "seq_a", name: "Outreach", enabled: true, steps: [emailStep] };
const contact = { id: "contact_a", name: "Ada", email: "ada@example.com" };
const enrollment: Enrollment = { id: "enr_a", sequenceId: "seq_a", contactId: "contact_a", status: "active", currentStep: 0, nextRunAt: "2026-11-25T20:00:00.000Z" };
const draft = () => draftStep(emailStep, "draft_a");

describe("Cadence step builder", () => {
  it("saves three ordered steps with numeric delays, stable ids, preserved fields and exit rules", () => {
    const steps = [0, 2, 5].map((delayDays, index) => draftStep({ subject: `Email ${index + 1}`, body: "Hello {{name}}", delayDays }, `draft_${index}`));
    const payload = sequencePayload(" Cadence ", true, steps, { exitRules: [{ type: "reply", active: true }] });
    expect(payload.name).toBe("Cadence");
    expect(payload.steps.map(row => row.order)).toEqual([0, 1, 2]);
    expect(payload.steps[1]).toMatchObject({ delayDays: 2, delayHours: 0, delayMinutes: 0, action: "sendEmail" });
    expect(payload.steps[2]).toMatchObject({ delayDays: 5, subject: "Email 3" });
    expect(draft()).toMatchObject({ subject: "Hello {{firstName}}", supported: true });
    expect(draft().source).toMatchObject({ id: "step_a" });
    expect(payload.exitRules).toEqual([{ type: "reply", active: true }]);
    expect(assertSequenceSaved({ id: "seq_a", ...payload }, payload, "seq_a").id).toBe("seq_a");
  });

  it("enforces trimmed name, step-count, subject, body and delay bounds", () => {
    expect(() => sequencePayload("x".repeat(101), true, [draft()])).toThrow("1-100");
    expect(() => sequencePayload(" ", true, [draft()])).toThrow("1-100");
    expect(() => sequencePayload("Cadence", true, [])).toThrow("1 and 20");
    expect(() => sequencePayload("Cadence", true, Array.from({ length: 21 }, (_, index) => draftStep(emailStep, `draft_${index}`)))).toThrow("1 and 20");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), subject: " " }])).toThrow("1-200");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), subject: "x".repeat(201) }])).toThrow("1-200");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), body: " " }])).toThrow("1-5000");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), body: "x".repeat(5001) }])).toThrow("1-5000");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), delayDays: "-1" }])).toThrow("whole number");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), delayDays: "1.5" }])).toThrow("whole number");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), delayDays: "Infinity" }])).toThrow("whole number");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), delayDays: "366" }])).toThrow("whole number");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), delayHours: "24" }])).toThrow("whole number");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), delayMinutes: "60" }])).toThrow("whole number");
  });

  it("rejects prototype-pollution keys in step sources and nested exit rules", () => {
    const source = JSON.parse('{"id":"step_p","subject":"Hello","body":"Message","__proto__":{"polluted":true},"nested":{"constructor":{"bad":true},"prototype":"bad","safe":"kept"}}') as Record<string, unknown>;
    const rules = JSON.parse('[{"type":"reply","active":true,"metadata":{"prototype":"bad","safe":1}}]');
    const payload = sequencePayload("Safe", true, [draftStep(source, "poison")], { exitRules: rules });
    const step = payload.steps[0];
    const nested = step.nested as Record<string, unknown>;
    const savedRules = payload.exitRules as Array<Record<string, unknown>>;
    const metadata = savedRules[0].metadata as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(step, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(nested, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(nested, "prototype")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(metadata, "prototype")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(nested.safe).toBe("kept");
    expect(metadata.safe).toBe(1);
    expect(assertSequenceSaved({ id: "seq_safe", ...payload }, payload, "seq_safe").id).toBe("seq_safe");
  });

  it("preserves unsupported legacy step types and their extra fields without dropping exit rules", () => {
    const mixed = sequencePayload("Mixed", true, [draftStep(emailStep, "email"), draftStep(legacyStep, "legacy")], { exitRules: [{ type: "meeting", active: false }] });
    expect(editableSteps({ ...sequence, steps: [emailStep, legacyStep] })).toBe(true);
    expect(mixed.steps[1]).toMatchObject({ id: "legacy_a", action: "createTask", title: "Legacy task", extra: "preserved", order: 1 });
    expect(mixed.exitRules).toEqual([{ type: "meeting", active: false }]);
    expect(assertSequenceSaved({ id: "seq_a", ...mixed }, mixed, "seq_a").id).toBe("seq_a");
  });

  it("accepts the actual API list shape and rejects malformed lists", () => {
    expect(parseSequences({ data: [sequence], total: 1 })).toEqual([sequence]);
    expect(parseSequences([sequence])).toEqual([sequence]);
    expect(() => parseSequences({ items: [sequence] })).toThrow("list");
    expect(() => parseSequences([{ name: "Missing ID" }])).toThrow("list");
  });

  it("confirms server persistence without assuming success from an HTTP status alone", () => {
    const payload = sequencePayload("Cadence", true, [draft()]);
    expect(() => assertSequenceSaved({ id: "seq_a", ...payload, steps: "description" }, payload)).toThrow("confirm");
    expect(() => assertSequenceSaved({ id: "wrong", ...payload }, payload, "seq_a")).toThrow("confirm");
    expect(() => assertSequenceSaved({ id: "seq_a", ...payload, steps: [{ ...payload.steps[0], id: "changed" }] }, payload, "seq_a")).toThrow("confirm");
    expect(() => assertSequenceSaved({ id: "seq_a", ...payload, steps: [{ ...payload.steps[0], action: "createTask" }] }, payload, "seq_a")).toThrow("confirm");
    expect(() => assertSequenceSaved({ id: "seq_a", ...payload, exitRules: [{ type: "reply", active: false }] }, payload, "seq_a")).not.toThrow();
  });

  it("recognizes unfinished legacy enrollments while allowing completed ones", () => {
    expect(legacyHasEnrollments({ ...sequence, enrolled: [{ currentStep: 0 }] })).toBe(true);
    expect(legacyHasEnrollments({ ...sequence, enrolled: [{ currentStep: 1 }, { currentStep: 0, unenrolledAt: "date" }] })).toBe(false);
  });

  it("formats delay in days, hours and minutes without claiming delivery", () => {
    expect(delayLabel(emailStep)).toBe("No delay");
    expect(delayLabel({ delayDays: 2, delayHours: 3, delayMinutes: 15 })).toBe("Wait 2 days, 3 hours, 15 minutes");
  });
});

describe("Contact cadence enrollment", () => {
  it("uses the first-class contactIds contract and prevents duplicates including paused records", () => {
    expect(enrollmentPayload(sequence, contact, [])).toEqual({ contactIds: ["contact_a"] });
    expect(() => enrollmentPayload(sequence, contact, [enrollment])).toThrow("already");
    expect(() => enrollmentPayload(sequence, contact, [{ ...enrollment, status: "paused" }])).toThrow("already");
    expect(enrollmentPayload(sequence, contact, [{ ...enrollment, contactId: "other" }])).toEqual({ contactIds: ["contact_a"] });
  });

  it.each(["replied", "stopped", "completed"])("permits an explicit new enrollment after %s", status => {
    expect(enrollmentPayload(sequence, contact, [{ ...enrollment, status }])).toEqual({ contactIds: ["contact_a"] });
  });

  it("blocks disabled, empty, legacy-only or invalid cadences and contacts without a valid email", () => {
    expect(() => enrollmentPayload({ ...sequence, enabled: false }, contact, [])).toThrow("enabled");
    expect(() => enrollmentPayload({ ...sequence, steps: [] }, contact, [])).toThrow("at least one step");
    expect(() => enrollmentPayload({ ...sequence, steps: [legacyStep] }, contact, [])).toThrow("enabled email cadence");
    expect(() => enrollmentPayload(sequence, { ...contact, email: "not-email" }, [])).toThrow("email address");
    expect(() => enrollmentPayload({ ...sequence, steps: [{ ...emailStep, body: "" }] }, contact, [])).toThrow("message");
  });

  it("distinguishes created and duplicate results and rejects mismatched responses", () => {
    expect(assertEnrollmentSaved({ enrolled: 1, skipped: 0, enrollments: [enrollment] }, sequence.id, contact.id)).toBe("Contact enrolled");
    expect(assertEnrollmentSaved({ enrolled: 0, skipped: 1, enrollments: [] }, sequence.id, contact.id)).toContain("no duplicate");
    expect(() => assertEnrollmentSaved({ seq: sequence, enrolled: 1 }, sequence.id, contact.id)).toThrow("confirm");
    expect(() => assertEnrollmentSaved({ enrolled: 1, skipped: 0, enrollments: [{ ...enrollment, contactId: "wrong" }] }, sequence.id, contact.id)).toThrow("confirm");
    expect(() => assertEnrollmentSaved({ enrolled: 1, skipped: 0, enrollments: [{ ...enrollment, sequenceId: "wrong" }] }, sequence.id, contact.id)).toThrow("confirm");
    expect(() => assertEnrollmentSaved({ enrolled: 0, skipped: 0, enrollments: [] }, sequence.id, contact.id)).toThrow("confirm");
  });

  it("validates enrollment status and timestamps", () => {
    expect(parseEnrollmentPage({ data: [{ ...enrollment, status: "replied", nextRunAt: null }], total: 1 }).data).toHaveLength(1);
    expect(() => parseEnrollmentPage({ data: [{ ...enrollment, status: "invented" }], total: 1 })).toThrow("response");
    expect(() => parseEnrollmentPage({ data: [{ ...enrollment, nextRunAt: "bad" }], total: 1 })).toThrow("response");
  });

  it("loads all pages using the paginated contract so a duplicate on page two cannot be missed", async () => {
    const get = vi.fn().mockResolvedValueOnce({ data: [{ ...enrollment, id: "enr_b", contactId: "other" }], total: 2 }).mockResolvedValueOnce({ data: [enrollment], total: 2 });
    const rows = await fetchEnrollments(sequence.id, get);
    expect(get.mock.calls[0][0]).toBe("/sequences/seq_a/enrollments?page=1&limit=50");
    expect(get.mock.calls[1][0]).toBe("/sequences/seq_a/enrollments?page=2&limit=50");
    expect(() => enrollmentPayload(sequence, contact, rows)).toThrow("already");
  });

  it("stops on incomplete or repeated pages and rows from a different sequence", async () => {
    const repeated = vi.fn().mockResolvedValue({ data: [enrollment], total: 2 });
    await expect(fetchEnrollments(sequence.id, repeated)).rejects.toThrow("incomplete");
    await expect(fetchEnrollments(sequence.id, vi.fn().mockResolvedValue({ data: [{ ...enrollment, sequenceId: "other" }], total: 1 }))).rejects.toThrow("another sequence");
  });

  it("propagates an unavailable enrollment API without changing to legacy enrollment", async () => {
    const get = vi.fn().mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
    await expect(fetchEnrollments(sequence.id, get)).rejects.toMatchObject({ status: 404 });
    expect(get).toHaveBeenCalledTimes(1);
  });
});
