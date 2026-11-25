import { describe, expect, it, vi } from "vitest";
import { allowedStages, boardStages, durationLabel, filterTickets, movePayload, parseTicketBoard, saveTicketMove, ticketCreatePayload, ticketSla, TICKET_STAGES, type Ticket } from "./ticketBoard";

const start = "2026-10-10T10:00:00.000Z";
const at = (hour: number) => Date.parse(start) + hour * 3600000;
const policy = { firstResponseHours: 4, resolutionHours: 48 };
const ticket: Ticket = { id: "one", subject: "Help with CRM", stage: "New", createdAt: start, priority: "Normal", contact: "Alex" };

describe("Ticket SLA clocks", () => {
  it("uses the supplied workspace targets for legacy tickets and ticks across a deadline", () => {
    const before = ticketSla(ticket, policy, at(4) - 1000);
    expect(before.first).toMatchObject({ state: "remaining", label: "1s left", dueAt: "2026-10-10T14:00:00.000Z" });
    expect(ticketSla(ticket, policy, at(4) + 1000).first).toMatchObject({ state: "overdue", label: "Overdue by 1s" });
    expect(ticketSla(ticket, policy, at(49)).overdue).toBe(true);
  });
  it("prefers persisted deadlines over current policy without inventing priority tiers", () => {
    const clocks = ticketSla({ ...ticket, priority: "Urgent", firstResponseDueAt: "2026-10-10T11:00:00Z", slaDueAt: "2026-10-10T12:00:00Z" }, policy, at(3));
    expect(clocks.first.state).toBe("overdue");
    expect(clocks.resolution.label).toBe("Overdue by 1h 0s");
  });
  it.each([undefined, "invalid"])("shows unavailable deadlines for a missing or invalid creation time (%s)", createdAt => {
    expect(ticketSla({ ...ticket, createdAt }, policy, at(3)).first.state).toBe("unknown");
  });
  it.each([{}, { firstResponseHours: 0 }, { firstResponseHours: -1 }, { firstResponseHours: Infinity }, { firstResponseHours: 1e308 }])("does not fabricate deadlines from an invalid policy (%j)", settings => {
    expect(ticketSla(ticket, settings, at(3)).first.state).toBe("unknown");
  });
  it("does not hide a malformed stored deadline behind a policy estimate", () => {
    expect(ticketSla({ ...ticket, firstResponseDueAt: "bad" }, policy, at(3)).first.state).toBe("unknown");
  });
  it("stops a response clock at its actual completion time and retains a missed target", () => {
    expect(ticketSla({ ...ticket, firstResponseAt: "2026-10-10T12:00:00Z" }, policy, at(10)).first.state).toBe("met");
    expect(ticketSla({ ...ticket, firstResponseAt: "2026-10-10T15:00:00Z" }, policy, at(10)).first.state).toBe("missed");
  });
  it.each(["Resolved", "Closed"])("does not flag a terminal %s ticket as currently overdue", stage => {
    const clocks = ticketSla({ ...ticket, stage, resolvedAt: "2026-10-12T12:00:00Z", slaBreached: true }, policy, at(100));
    expect(clocks.overdue).toBe(false);
    expect(clocks.resolution.state).toBe("missed");
  });
  it("does not claim a terminal ticket met its target without a completion timestamp", () => {
    expect(ticketSla({ ...ticket, stage: "Resolved" }, policy, at(100)).resolution.state).toBe("stopped");
  });
  it("resumes the resolution clock on reopening despite a historical resolution timestamp", () => {
    const clocks = ticketSla({ ...ticket, stage: "In Progress", firstResponseAt: "2026-10-10T12:00:00Z", resolvedAt: "2026-10-11T10:00:00Z" }, policy, at(49));
    expect(clocks.resolution.state).toBe("overdue");
  });
  it("honors authoritative server breach flags even when the deadline is unavailable", () => {
    expect(ticketSla({ ...ticket, firstResponseBreached: true }, {}, at(3)).overdue).toBe(true);
  });
  it("formats days and seconds without negative durations", () => expect(durationLabel(-90061000)).toBe("1d 1h 1m 1s"));
});

describe("Ticket board and stage moves", () => {
  it("keeps empty canonical columns, Closed and unknown stages without dropping tickets", () => {
    const board = parseTicketBoard({ data: [ticket, { ...ticket, id: "two", stage: "Closed" }, { ...ticket, id: "three", stage: "Legacy" }], total: 3, sla: policy });
    expect(board.stages).toEqual([...TICKET_STAGES, "Closed", "Legacy"]);
    expect(boardStages([{ ...ticket, stage: "" }])).toContain("Unassigned");
  });
  it.each([{}, { data: [ticket], total: 2 }, { data: [ticket, ticket], total: 2 }, { data: [{ id: "bad" }] }])("rejects incomplete or malformed board responses (%j)", value => {
    expect(() => parseTicketBoard(value)).toThrow();
  });
  it("offers only transitions supported by the backend stage contract", () => {
    const columns = [...TICKET_STAGES, "Closed"];
    expect(allowedStages(ticket, columns)).not.toContain("Closed");
    expect(allowedStages({ ...ticket, stage: "Resolved" }, columns)).toEqual(["In Progress", "Awaiting Client", "Resolved", "Closed"]);
    expect(() => movePayload(ticket, "Unknown", columns)).toThrow();
  });
  it("preserves existing response and resolution stamps without sending unrelated fields", () => {
    expect(movePayload({ ...ticket, stage: "Resolved", firstResponseAt: start, resolvedAt: start }, "In Progress", TICKET_STAGES)).toEqual({ stage: "In Progress", firstResponseAt: start, resolvedAt: start });
    expect(movePayload(ticket, "In Progress", TICKET_STAGES)).toEqual({ stage: "In Progress" });
  });
  it("returns only a server-confirmed move and leaves the original record unchanged", async () => {
    const send = vi.fn().mockResolvedValue({ ...ticket, stage: "In Progress" });
    expect((await saveTicketMove(ticket, "In Progress", TICKET_STAGES, send)).stage).toBe("In Progress");
    expect(send).toHaveBeenCalledOnce();
    expect(ticket.stage).toBe("New");
  });
  it("keeps a rejected move unchanged and propagates the server error", async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("Invalid transition"), { status: 400 }));
    await expect(saveTicketMove(ticket, "In Progress", TICKET_STAGES, send)).rejects.toThrow("Invalid transition");
    expect(ticket.stage).toBe("New");
    expect(send).toHaveBeenCalledOnce();
  });
  it.each([{ ...ticket }, { ...ticket, id: "another", stage: "In Progress" }, {}])("rejects an unconfirmed move response (%j)", result => {
    return expect(saveTicketMove(ticket, "In Progress", TICKET_STAGES, vi.fn().mockResolvedValue(result))).rejects.toThrow();
  });
  it("combines text, priority and overdue filters across the full record set", () => {
    const rows = [ticket, { ...ticket, id: "two", priority: "High" }, { ...ticket, id: "three", priority: "High", stage: "Resolved" }];
    expect(filterTickets(rows, " alex ", "High", true, policy, at(49)).map(row => row.id)).toEqual(["two"]);
  });
  it("validates ticket creation and excludes client-controlled identifiers and timestamps", () => {
    const payload = ticketCreatePayload({ subject: " Help ", priority: "Normal", source: "Email", id: "fake", firstResponseAt: start });
    expect(payload.subject).toBe("Help");
    expect(payload).not.toHaveProperty("id");
    expect(payload).not.toHaveProperty("firstResponseAt");
    expect(() => ticketCreatePayload({ subject: "", priority: "Normal" })).toThrow("Subject");
    expect(() => ticketCreatePayload({ subject: "Help", priority: "Normal", contactEmail: "bad" })).toThrow("email");
  });
});
