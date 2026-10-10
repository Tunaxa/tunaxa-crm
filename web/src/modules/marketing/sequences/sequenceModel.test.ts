import { describe, expect, it, vi } from "vitest";
import { assertEnrollmentSaved, assertSequenceSaved, delayLabel, draftStep, editableSteps, enrollmentPayload, fetchEnrollments, legacyHasEnrollments, parseEnrollmentPage, parseSequences, sequencePayload, type Enrollment, type Sequence } from "./sequenceModel";

const email = { id: "step_a", action: "email", subject: "Hello {{name}}", body: "Message", delayDays: 0, order: 0, extra: "preserve", to: "{{email}}" };
const sequence: Sequence = { id: "seq_a", name: "Outreach", enabled: true, steps: [email] };
const contact = { id: "contact_a", email: "person@example.com" };
const enrollment: Enrollment = { id: "enr_a", sequenceId: "seq_a", contactId: "contact_a", status: "active", currentStep: 0, nextRunAt: "2026-10-10T20:00:00.000Z" };
const draft = () => draftStep(email, "draft_a");

describe("Cadence step builder", () => {
  it("saves three ordered steps with numeric delays, stable ids and preserved fields", () => {
    const second = draftStep({ subject: "Follow up", body: "Second message", delayDays: 2, delayHours: 3, delayMinutes: 15 }, "draft_b");
    const third = draftStep({ subject: "Final follow up", body: "Third message", delayDays: 5 }, "draft_c");
    const payload = sequencePayload(" Cadence ", true, [second, draft(), third]);
    expect(payload.name).toBe("Cadence");
    expect(payload.steps).toHaveLength(3);
    expect(payload.steps.map(row => row.order)).toEqual([0, 1, 2]);
    expect(payload.steps[0]).toMatchObject({ delayDays: 2, delayHours: 3, delayMinutes: 15, action: "sendEmail" });
    expect(payload.steps[1]).toMatchObject({ id: "step_a", extra: "preserve", to: "{{email}}", action: "email" });
  });
  it.each(["-1", "1.5", "Infinity", "wrong", "", "9007199254740992"])("rejects invalid day delays %j", delayDays => {
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), delayDays }])).toThrow("whole number");
  });
  it("rejects overflow hours/minutes, blank messages/names and empty cadences", () => {
    expect(() => sequencePayload("", true, [draft()])).toThrow("name");
    expect(() => sequencePayload("Cadence", true, [])).toThrow("one email");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), subject: " " }])).toThrow("subject");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), body: " " }])).toThrow("message");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), delayHours: "24" }])).toThrow("hours");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), delayMinutes: "60" }])).toThrow("minutes");
    expect(() => sequencePayload("Cadence", true, [{ ...draft(), delayDays: "100000000" }])).toThrow("too large");
  });
  it("preserves unsupported/legacy cadences by identifying them before editing", () => {
    expect(editableSteps(sequence)).toBe(true);
    expect(editableSteps({ ...sequence, steps: "Old description" })).toBe(false);
    expect(editableSteps({ ...sequence, steps: [{ ...email, action: "createTask" }] })).toBe(false);
    expect(editableSteps({ ...sequence, steps: [null] })).toBe(false);
    expect(() => sequencePayload("Cadence", true, [draftStep({ ...email, action: "createTask" }, "bad")])).toThrow("email steps only");
  });
  it("accepts the actual API list shape and rejects malformed lists", () => {
    expect(parseSequences({ data: [sequence], total: 1 })).toEqual([sequence]);
    expect(parseSequences([sequence])).toEqual([sequence]);
    expect(() => parseSequences({ items: [sequence] })).toThrow("list");
    expect(() => parseSequences([{ name: "Missing ID" }])).toThrow("list");
  });
  it("confirms server persistence without assuming success from an HTTP status alone", () => {
    const payload = sequencePayload("Cadence", true, [draft()]);
    expect(assertSequenceSaved({ id: sequence.id, ...payload }, payload, sequence.id).id).toBe(sequence.id);
    expect(() => assertSequenceSaved({ id: sequence.id, ...payload, steps: "description" }, payload)).toThrow("confirm");
    expect(() => assertSequenceSaved({ id: "wrong", ...payload }, payload, sequence.id)).toThrow("confirm");
    expect(() => assertSequenceSaved({ id: sequence.id, ...payload, steps: [{ ...payload.steps[0], id: "changed" }] }, payload, sequence.id)).toThrow("confirm");
    expect(() => assertSequenceSaved({ id: sequence.id, ...payload, steps: [{ ...payload.steps[0], action: "createTask" }] }, payload, sequence.id)).toThrow("confirm");
  });
  it("recognizes unfinished legacy enrollments while allowing completed ones", () => {
    expect(legacyHasEnrollments({ ...sequence, enrolled: [{ currentStep: 0 }] })).toBe(true);
    expect(legacyHasEnrollments({ ...sequence, enrolled: [{ currentStep: 1 }, { currentStep: 0, unenrolledAt: "date" }] })).toBe(false);
  });
  it("formats delay in days, hours and minutes without claiming delivery", () => {
    expect(delayLabel(email)).toBe("No delay");
    expect(delayLabel({ delayDays: 2, delayHours: 3, delayMinutes: 15 })).toBe("Wait 2 days, 3 hours, 15 minutes");
  });
});

describe("Contact cadence enrollment", () => {
  it("uses the first-class contactIds contract and prevents duplicates including paused records", () => {
    expect(enrollmentPayload(sequence, contact, [])).toEqual({ contactIds: [contact.id] });
    expect(() => enrollmentPayload(sequence, contact, [enrollment])).toThrow("already");
    expect(() => enrollmentPayload(sequence, contact, [{ ...enrollment, status: "paused" }])).toThrow("already");
    expect(enrollmentPayload(sequence, contact, [{ ...enrollment, contactId: "other" }])).toEqual({ contactIds: [contact.id] });
  });
  it.each(["replied", "stopped", "completed"])("permits an explicit new enrollment after %s", status => {
    expect(enrollmentPayload(sequence, contact, [{ ...enrollment, status }])).toEqual({ contactIds: [contact.id] });
  });
  it("blocks disabled, empty or invalid cadences and contacts without valid email", () => {
    expect(() => enrollmentPayload({ ...sequence, enabled: false }, contact, [])).toThrow("enabled");
    expect(() => enrollmentPayload({ ...sequence, steps: [] }, contact, [])).toThrow("one step");
    expect(() => enrollmentPayload(sequence, { ...contact, email: "not-email" }, [])).toThrow("email address");
    expect(() => enrollmentPayload({ ...sequence, steps: [{ ...email, body: "" }] }, contact, [])).toThrow("message");
  });
  it("distinguishes created and duplicate results, rejects legacy or mismatched responses", () => {
    expect(assertEnrollmentSaved({ enrolled: 1, skipped: 0, enrollments: [enrollment] }, sequence.id, contact.id)).toBe("Contact enrolled");
    expect(assertEnrollmentSaved({ enrolled: 0, skipped: 1, enrollments: [] }, sequence.id, contact.id)).toContain("no duplicate");
    expect(() => assertEnrollmentSaved({ seq: sequence, enrolled: 1 }, sequence.id, contact.id)).toThrow("confirm");
    expect(() => assertEnrollmentSaved({ enrolled: 1, skipped: 0, enrollments: [{ ...enrollment, contactId: "wrong" }] }, sequence.id, contact.id)).toThrow("confirm");
    expect(() => assertEnrollmentSaved({ enrolled: 0, skipped: 0, enrollments: [] }, sequence.id, contact.id)).toThrow("confirm");
  });
  it("validates enrollment status and timestamps", () => {
    expect(parseEnrollmentPage({ data: [{ ...enrollment, status: "replied", nextRunAt: null }], total: 1 }).data).toHaveLength(1);
    expect(() => parseEnrollmentPage({ data: [{ ...enrollment, status: "invented" }], total: 1 })).toThrow("response");
    expect(() => parseEnrollmentPage({ data: [{ ...enrollment, nextRunAt: "bad" }], total: 1 })).toThrow("response");
  });
  it("loads all pages so a duplicate on page two cannot be missed", async () => {
    const get = vi.fn().mockResolvedValueOnce({ data: [{ ...enrollment, id: "other", contactId: "other" }], total: 2 }).mockResolvedValueOnce({ data: [enrollment], total: 2 });
    const rows = await fetchEnrollments(sequence.id, get);
    expect(get.mock.calls[1][0]).toContain("page=2&limit=50");
    expect(() => enrollmentPayload(sequence, contact, rows)).toThrow("already");
  });
  it("stops on incomplete/repeated pages or rows from a different sequence", async () => {
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
