// SLA evaluation engine for support tickets (P2-BE2-02).
//
// Everything here is pure: it takes a ticket (in either the legacy camelCase or
// raw snake_case shape), a priority and an explicit "now", and returns due dates
// or breach flags. The route persists the due dates on create/transition and
// recomputes the flags on read, so no scheduler is required and the result is
// deterministic under test.
//
// Response targets are expressed in hours and keyed by the priority the CRM
// stores. `normal` mirrors the historical workspace default (4h first response /
// 48h resolution) so existing boards are unchanged; the other tiers scale
// around it.

import { isTerminalStage } from './ticket-stages.js';

export const DEFAULT_SLA_TARGETS = {
  urgent: { firstResponseHours: 1, resolutionHours: 4 },
  high: { firstResponseHours: 2, resolutionHours: 8 },
  medium: { firstResponseHours: 4, resolutionHours: 24 },
  normal: { firstResponseHours: 4, resolutionHours: 48 },
  low: { firstResponseHours: 8, resolutionHours: 72 },
};

// The single settings object the workspace can override via PUT /api/tickets/sla.
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
 * Resolve the hours target for a ticket. An explicit workspace override
 * (`db.ticketSla`) wins for every priority; otherwise the priority tier is used,
 * falling back to Normal for unknown values.
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

/**
 * Compute the first-response and resolution deadlines for a ticket created at
 * `createdAt` with the given priority. Returns ISO strings plus the resolved
 * target so callers can echo what was used.
 */
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
 * Breach state for a ticket at a point in time.
 *
 *  - `firstResponseBreached`: `firstResponseDueAt` has passed and no first
 *    response has been recorded.
 *  - `resolutionBreached` / `isBreached`: `slaDueAt` has passed and the ticket
 *    is still in an active (non-terminal) stage.
 *
 * Accepts camelCase (legacy) or snake_case (raw row) field names so it can run
 * both before and after the legacy-shape mapping.
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
  const resolutionBreached = Boolean(
    slaDueAt && !terminal && current > slaDueAt,
  );

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
 * Side effects of moving a ticket into `targetStage`. Returns a camelCase patch
 * the route can spread into the request body; the body always wins so a caller
 * may supply an explicit timestamp.
 *
 *  - Leaving `New` records the first response.
 *  - Entering `Resolved` records `resolvedAt` / `resolvedBy`.
 *  - Entering `Closed` also records `closedAt` (and ensures a resolution stamp).
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
