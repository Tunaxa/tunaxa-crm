/**
 * Duration parsing helper for workflow delays and scheduled executions.
 * Converts human-readable strings, structured duration objects, or numbers to milliseconds.
 */

const UNIT_MULTIPLIERS = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  mins: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hrs: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  wk: 7 * 24 * 60 * 60 * 1000,
  wks: 7 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
};

function getMultiplier(unit) {
  if (!unit) return 0;
  const normalized = String(unit).trim().toLowerCase();
  return UNIT_MULTIPLIERS[normalized] || 0;
}

/**
 * Parses a delay definition into milliseconds.
 *
 * Supported formats:
 * - String: "1 day", "2 days", "1d", "2 hours", "1 hour", "4h", "30 minutes",
 *           "15 mins", "10m", "45 seconds", "30s", "1 week", "2 weeks", "1w"
 * - Object: { amount: 1, unit: 'days' }, { delay: '1 day' }, { duration: '2 hours' }
 * - Number: Raw number of milliseconds.
 *
 * @param {string|number|object} delay
 * @returns {number} Duration in milliseconds (>= 0)
 */
export function parseDelayToMs(delay) {
  if (delay === null || delay === undefined) return 0;

  // Raw number (treated as milliseconds)
  if (typeof delay === 'number') {
    return Number.isFinite(delay) && delay > 0 ? Math.round(delay) : 0;
  }

  // Object forms: { delay }, { duration }, or { amount, unit }
  if (typeof delay === 'object') {
    if (delay.delay !== undefined) {
      return parseDelayToMs(delay.delay);
    }
    if (delay.duration !== undefined) {
      return parseDelayToMs(delay.duration);
    }
    if (delay.amount !== undefined && delay.unit !== undefined) {
      const amount = Number(delay.amount);
      if (!Number.isFinite(amount) || amount <= 0) return 0;
      const mult = getMultiplier(delay.unit);
      return Math.round(amount * mult);
    }
    return 0;
  }

  // String forms
  if (typeof delay === 'string') {
    const trimmed = delay.trim();
    if (!trimmed) return 0;

    // Check if purely a positive numeric string (milliseconds)
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      return Number.isFinite(num) && num > 0 ? Math.round(num) : 0;
    }

    // Match e.g. "1 day", "2.5 hours", "10m", "45s", "1w", "2days"
    const match = trimmed.match(/^([\d.]+)\s*([a-zA-Z]+)$/);
    if (!match) return 0;

    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || amount <= 0) return 0;

    const mult = getMultiplier(unit);
    return Math.round(amount * mult);
  }

  return 0;
}
