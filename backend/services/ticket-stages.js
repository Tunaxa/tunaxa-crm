// Ticket Kanban stage model (P2-BE2-02).
//
// Support tickets move through a Kanban board. `KANBAN_STAGES` is the canonical
// left-to-right column order the board renders. `ADDITIONAL_STAGES` adds the
// terminal `Closed` column, which `buildStageSummary` only surfaces once a
// ticket actually uses it: a board with no closed tickets therefore keeps the
// historical four-column shape (and the existing contract tests) intact.
//
// This module has no Express or database dependency on purpose. The route, the
// repository and the SLA engine all import it, so the stage vocabulary and the
// transition rules have exactly one definition.

export const KANBAN_STAGES = [
  'New',
  'In Progress',
  'Awaiting Client',
  'Resolved',
];

// `Closed` is a first-class terminal stage but is not part of the historical
// default board. buildStageSummary appends any additional stage that appears in
// the data, so the column shows up exactly when it has cards.
export const ADDITIONAL_STAGES = ['Closed'];

export const RECOGNIZED_STAGES = [...KANBAN_STAGES, ...ADDITIONAL_STAGES];

export const TERMINAL_STAGES = new Set(['Resolved', 'Closed']);

/** True for stages that end a ticket's active SLA clock. */
export function isTerminalStage(stage) {
  return TERMINAL_STAGES.has(stage);
}

/** True for any stage the API will accept as a target. */
export function isValidStage(stage) {
  return RECOGNIZED_STAGES.includes(stage);
}

// Allowed moves. A terminal ticket may be reopened, which is why Resolved and
// Closed are not sinks, but a ticket cannot jump straight to Closed without
// being Resolved first.
export const STAGE_TRANSITIONS = {
  New: ['In Progress', 'Awaiting Client', 'Resolved'],
  'In Progress': ['New', 'Awaiting Client', 'Resolved'],
  'Awaiting Client': ['New', 'In Progress', 'Resolved'],
  Resolved: ['In Progress', 'Awaiting Client', 'Closed'],
  Closed: ['In Progress', 'Awaiting Client'],
};

/**
 * Whether `to` is a legal move from `from`. Re-entering the current stage is a
 * no-op and is allowed so an idempotent PUT does not fail.
 */
export function canTransition(from, to) {
  if (!isValidStage(from) || !isValidStage(to)) return false;
  if (from === to) return true;
  return (STAGE_TRANSITIONS[from] || []).includes(to);
}

/**
 * Build the `stages` array the board consumes: the canonical columns (always
 * present, count 0 when empty) plus any additional or custom stage found in the
 * data, so no card silently disappears from the board.
 */
export function buildStageSummary(tickets) {
  const list = Array.isArray(tickets) ? tickets : [];
  const counts = new Map();
  for (const ticket of list) {
    const stage = ticket && typeof ticket === 'object' ? ticket.stage : null;
    if (typeof stage !== 'string' || !stage) continue;
    counts.set(stage, (counts.get(stage) || 0) + 1);
  }

  const columns = [...KANBAN_STAGES];
  for (const stage of ADDITIONAL_STAGES) {
    if (counts.has(stage)) columns.push(stage);
  }
  for (const stage of counts.keys()) {
    if (!columns.includes(stage)) columns.push(stage);
  }

  return columns.map((stage) => ({ stage, count: counts.get(stage) || 0 }));
}
