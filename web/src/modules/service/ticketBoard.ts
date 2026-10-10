export type Ticket = {
  id: string; subject: string; stage: string; priority?: string; source?: string;
  contact?: string; contactEmail?: string; description?: string; createdAt?: string;
  firstResponseAt?: string; resolvedAt?: string; closedAt?: string;
  firstResponseDueAt?: string; slaDueAt?: string;
  firstResponseBreached?: boolean; resolutionBreached?: boolean; slaBreached?: boolean;
};
export type SlaPolicy = { firstResponseHours?: number; resolutionHours?: number };
export type TicketBoard = { data: Ticket[]; stages: string[]; sla: SlaPolicy; total: number };
export type SlaClock = { state: "remaining" | "overdue" | "met" | "missed" | "stopped" | "unknown"; label: string; dueAt?: string };
export const TICKET_STAGES = ["New", "In Progress", "Awaiting Client", "Resolved"];
const transitions: Record<string, string[]> = {
  New: ["In Progress", "Awaiting Client", "Resolved"],
  "In Progress": ["New", "Awaiting Client", "Resolved"],
  "Awaiting Client": ["New", "In Progress", "Resolved"],
  Resolved: ["In Progress", "Awaiting Client", "Closed"],
  Closed: ["In Progress", "Awaiting Client"],
};
export const isTerminal = (stage: string) => stage === "Resolved" || stage === "Closed";

export function parseTicket(value: unknown): Ticket {
  if (!value || typeof value !== "object") throw new Error("Invalid ticket response");
  const row = value as Ticket;
  if (typeof row.id !== "string" || !row.id || typeof row.subject !== "string" || typeof row.stage !== "string") throw new Error("Invalid ticket response");
  return { ...row, stage: row.stage || "Unassigned" };
}
export function boardStages(rows: Ticket[], stages: string[] = TICKET_STAGES): string[] {
  return [...new Set([...TICKET_STAGES, ...stages.filter(Boolean), ...rows.map(row => row.stage || "Unassigned")])];
}
export function parseTicketBoard(value: unknown): TicketBoard {
  const response = value as { data?: unknown[]; stages?: { stage?: string }[]; sla?: SlaPolicy; total?: number };
  if (!response || !Array.isArray(response.data)) throw new Error("Invalid ticket board response");
  const data = response.data.map(parseTicket);
  if (new Set(data.map(row => row.id)).size !== data.length) throw new Error("Ticket board contains duplicate records");
  if (response.total !== undefined && response.total !== data.length) throw new Error("The server returned an incomplete ticket board. Refresh before moving tickets.");
  const stages = Array.isArray(response.stages) ? response.stages.map(row => row?.stage).filter((stage): stage is string => typeof stage === "string") : [];
  return { data, stages: boardStages(data, stages), sla: response.sla || {}, total: data.length };
}
function timestamp(value?: string): number | undefined {
  if (!value || typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
function dueDate(explicit: string | undefined, createdAt: string | undefined, hours: number | undefined): number | undefined {
  if (explicit !== undefined && explicit !== null) return timestamp(explicit);
  const created = timestamp(createdAt);
  const due = created !== undefined && typeof hours === "number" && Number.isFinite(hours) && hours > 0 ? created + hours * 3600000 : NaN;
  return Number.isFinite(due) && Number.isFinite(new Date(due).getTime()) ? due : undefined;
}
export function durationLabel(ms: number): string {
  const seconds = Math.ceil(Math.abs(ms) / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${seconds % 60}s`].filter(Boolean).join(" ");
}
function clock(due: number | undefined, completion: number | undefined, stopped: boolean, now: number): SlaClock {
  const dueAt = due === undefined ? undefined : new Date(due).toISOString();
  if (due === undefined) return { state: "unknown", label: "Deadline unavailable" };
  if (completion !== undefined) return { state: completion > due ? "missed" : "met", label: completion > due ? "Target missed" : "Target met", dueAt };
  if (stopped) return { state: "stopped", label: "Clock stopped", dueAt };
  const remaining = due - now;
  return { state: remaining < 0 ? "overdue" : "remaining", label: remaining < 0 ? `Overdue by ${durationLabel(remaining)}` : `${durationLabel(remaining)} left`, dueAt };
}
export function ticketSla(ticket: Ticket, policy: SlaPolicy, now: number) {
  const terminal = isTerminal(ticket.stage);
  const first = clock(dueDate(ticket.firstResponseDueAt, ticket.createdAt, policy.firstResponseHours), timestamp(ticket.firstResponseAt), terminal, now);
  const resolution = clock(dueDate(ticket.slaDueAt, ticket.createdAt, policy.resolutionHours), terminal ? timestamp(ticket.resolvedAt || ticket.closedAt) : undefined, terminal, now);
  const overdue = !terminal && (first.state === "overdue" || resolution.state === "overdue" || ticket.firstResponseBreached === true || ticket.resolutionBreached === true || ticket.slaBreached === true);
  return { first, resolution, overdue };
}
export function allowedStages(ticket: Ticket, columns: string[]): string[] {
  return columns.filter(stage => stage === ticket.stage || transitions[ticket.stage]?.includes(stage));
}
export function movePayload(ticket: Ticket, stage: string, columns: string[]): Record<string, string> {
  if (!columns.includes(stage) || !allowedStages(ticket, columns).includes(stage)) throw new Error(`Cannot move this ticket to ${stage}`);
  // Preserve existing response/resolution stamps when using the legacy PUT route.
  // The newer backend also accepts these fields and owns new transition stamps.
  return { stage, ...(ticket.firstResponseAt ? { firstResponseAt: ticket.firstResponseAt } : {}), ...(ticket.resolvedAt ? { resolvedAt: ticket.resolvedAt } : {}) };
}
export async function saveTicketMove(ticket: Ticket, stage: string, columns: string[], send: (payload: Record<string, string>) => Promise<unknown>): Promise<Ticket> {
  const payload = movePayload(ticket, stage, columns);
  const saved = parseTicket(await send(payload));
  if (saved.id !== ticket.id || saved.stage !== stage) throw new Error("The server did not confirm the ticket move. Refresh the board before trying again.");
  return saved;
}
export function ticketCreatePayload(data: Record<string, unknown>): Record<string, string> {
  const keys = ["subject", "contact", "contactEmail", "description", "priority", "source"];
  const result = Object.fromEntries(keys.map(key => [key, String(data[key] ?? "").trim()]));
  if (!result.subject) throw new Error("Subject is required");
  if (result.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.contactEmail)) throw new Error("Enter a valid contact email");
  if (!["Low", "Normal", "Medium", "High", "Urgent"].includes(result.priority)) throw new Error("Choose a ticket priority");
  return result;
}
export function filterTickets(rows: Ticket[], query: string, priority: string, onlyOverdue: boolean, policy: SlaPolicy, now: number) {
  const search = query.trim().toLowerCase();
  return rows.filter(row => (!priority || row.priority === priority) && (!onlyOverdue || ticketSla(row, policy, now).overdue)
    && (!search || [row.subject, row.contact, row.contactEmail, row.description].some(value => value?.toLowerCase().includes(search))));
}
