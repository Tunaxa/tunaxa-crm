// Ticket Kanban stage model (P2-BE2-02).
//
// Canonical left-to-right Kanban columns. `Closed` is terminal and surfaced
// dynamically once a ticket uses it so boards keep the historical four-column
// shape when empty. Pure module: no Express/DB/timers.

export const KANBAN_STAGES = [
  'New',
  'In Progress',
  'Awaiting Client',
  'Resolved',
];

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

// Allowed moves. Terminal tickets may be reopened, but cannot jump straight to
// Closed without being Resolved first.
export const STAGE_TRANSITIONS = {
  New: ['In Progress', 'Awaiting Client', 'Resolved'],
  'In Progress': ['New', 'Awaiting Client', 'Resolved'],
  'Awaiting Client': ['New', 'In Progress', 'Resolved'],
  Resolved: ['In Progress', 'Awaiting Client', 'Closed'],
  Closed: ['In Progress', 'Awaiting Client'],
};

/** Re-entering the current stage is an idempotent no-op. */
export function canTransition(from, to) {
  if (!isValidStage(from) || !isValidStage(to)) return false;
  if (from === to) return true;
  return (STAGE_TRANSITIONS[from] || []).includes(to);
}

/**
 * Canonical columns (always present) plus any additional/custom stage found in
 * the data so no card disappears from the board.
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
