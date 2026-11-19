// SLA evaluation engine for support tickets (P2-BE2-02).
// Pure, deterministic, no timers/schedulers/IO.

import { isTerminalStage } from './ticket-stages.js';

export const DEFAULT_SLA_TARGETS = {
  urgent: { firstResponseHours: 1, resolutionHours: 4 },
  high: { firstResponseHours: 2, resolutionHours: 8 },
  medium: { firstResponseHours: 4, resolutionHours: 24 },
  normal: { firstResponseHours: 4, resolutionHours: 48 },
  low: { firstResponseHours: 8, resolutionHours: 72 },
};

// Workspace-level settings object (stored in JSON db.ticketSla).
export const DEFAULT_SLA = { firstResponseHours: 4, resolutionHours: 48 };

const HOUR_MS = 60 * 60 * 1000;

function toDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function positiveHours(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Lower-case priority key, falling back to `normal` for unknown values. */
export function normalizePriority(priority) {
  const key = String(priority ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(DEFAULT_SLA_TARGETS, key)
    ? key
    : 'normal';
}

/**
 * Resolve target hours. An explicit workspace override wins for every priority;
 * otherwise the priority tier is used.
 */
export function resolveSlaTarget(priority, settings) {
  const tier = DEFAULT_SLA_TARGETS[normalizePriority(priority)];
  const base = settings && typeof settings === 'object' ? settings : null;
  return {
    firstResponseHours: positiveHours(
      base?.firstResponseHours,
      tier.firstResponseHours,
    ),
    resolutionHours: positiveHours(base?.resolutionHours, tier.resolutionHours),
  };
}

/** Compute first-response and resolution deadlines for a ticket. */
export function computeSlaDueDates({ priority, createdAt, settings } = {}) {
  const start = toDate(createdAt) || new Date();
  const target = resolveSlaTarget(priority, settings);
  return {
    firstResponseDueAt: new Date(
      start.getTime() + target.firstResponseHours * HOUR_MS,
    ).toISOString(),
    slaDueAt: new Date(
      start.getTime() + target.resolutionHours * HOUR_MS,
    ).toISOString(),
    target,
  };
}

/**
 * Breach state at a point in time. Accepts camelCase or snake_case fields.
 * - firstResponseBreached: due passed and no first response recorded.
 * - resolutionBreached/isBreached: slaDueAt passed and ticket not terminal.
 */
export function evaluateSlaBreach(ticket, { now = new Date(), settings } = {}) {
  const current = toDate(now) || new Date();
  const terminal = isTerminalStage(ticket?.stage);

  const firstResponseAt = toDate(
    ticket?.firstResponseAt ?? ticket?.first_response_at,
  );
  const firstResponseDueAt = toDate(
    ticket?.firstResponseDueAt ??
      ticket?.first_response_due_at ??
      (settings
        ? computeSlaDueDates({
            priority: ticket?.priority,
            createdAt: ticket?.createdAt ?? ticket?.created_at,
            settings,
          }).firstResponseDueAt
        : null),
  );
  const slaDueAt = toDate(
    ticket?.slaDueAt ??
      ticket?.sla_due_at ??
      (settings
        ? computeSlaDueDates({
            priority: ticket?.priority,
            createdAt: ticket?.createdAt ?? ticket?.created_at,
            settings,
          }).slaDueAt
        : null),
  );

  const firstResponseBreached = Boolean(
    firstResponseDueAt && !firstResponseAt && current > firstResponseDueAt,
  );
  const resolutionBreached = Boolean(slaDueAt && !terminal && current > slaDueAt);

  return {
    firstResponseBreached,
    resolutionBreached,
    isBreached: resolutionBreached,
    firstResponseDueAt: firstResponseDueAt
      ? firstResponseDueAt.toISOString()
      : null,
    slaDueAt: slaDueAt ? slaDueAt.toISOString() : null,
  };
}

/**
 * Side effects of moving a ticket into `targetStage`. Caller may override with
 * explicit timestamps. Records first response, resolution/closed stamps.
 */
export function transitionPatch(ticket, targetStage, { actor, at } = {}) {
  const when = toDate(at) || new Date();
  const iso = when.toISOString();
  const patch = {};
  if (!ticket || ticket.stage === targetStage) return patch;

  patch.stage = targetStage;

  if (!ticket.firstResponseAt && targetStage !== 'New') {
    patch.firstResponseAt = iso;
  }
  if (targetStage === 'Resolved' || targetStage === 'Closed') {
    if (!ticket.resolvedAt) patch.resolvedAt = iso;
    if (!ticket.resolvedBy) patch.resolvedBy = actor;
  }
  if (targetStage === 'Closed' && !ticket.closedAt) {
    patch.closedAt = iso;
  }
  return patch;
}
