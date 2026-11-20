export const KANBAN_STAGES = [
  'New',
  'In Progress',
  'Awaiting Client',
  'Resolved',
];

export const ADDITIONAL_STAGES = ['Closed'];

export const RECOGNIZED_STAGES = [...KANBAN_STAGES, ...ADDITIONAL_STAGES];

export const TERMINAL_STAGES = new Set(['Resolved', 'Closed']);

export function isTerminalStage(stage) {
  return TERMINAL_STAGES.has(stage);
}

export function isValidStage(stage) {
  return RECOGNIZED_STAGES.includes(stage);
}

export const STAGE_TRANSITIONS = {
  New: ['In Progress', 'Awaiting Client', 'Resolved'],
  'In Progress': ['New', 'Awaiting Client', 'Resolved'],
  'Awaiting Client': ['New', 'In Progress', 'Resolved'],
  Resolved: ['In Progress', 'Awaiting Client', 'Closed'],
  Closed: ['In Progress', 'Awaiting Client'],
};

export function canTransition(from, to) {
  if (!isValidStage(from) || !isValidStage(to)) return false;
  if (from === to) return true;
  return (STAGE_TRANSITIONS[from] || []).includes(to);
}

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