export function matchCondition(record, condition) {
  if (!condition || !condition.field) return true;
  const actual = record[condition.field];
  const expected = condition.value;
  switch (condition.op || 'eq') {
    case 'eq': return String(actual ?? '') === String(expected ?? '');
    case 'neq': return String(actual ?? '') !== String(expected ?? '');
    case 'contains': return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'notContains': return !String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'gt': return Number(actual) > Number(expected);
    case 'gte': return Number(actual) >= Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    case 'in': {
      const list = Array.isArray(expected) ? expected.map(x => String(x ?? '').trim().toLowerCase()) : String(expected ?? '').split(',').map(x => x.trim().toLowerCase());
      return list.includes(String(actual ?? '').trim().toLowerCase());
    }
    case 'notIn': {
      const list = Array.isArray(expected) ? expected.map(x => String(x ?? '').trim().toLowerCase()) : String(expected ?? '').split(',').map(x => x.trim().toLowerCase());
      return !list.includes(String(actual ?? '').trim().toLowerCase());
    }
    case 'isSet': return actual !== undefined && actual !== null && actual !== '';
    case 'isNotSet': return actual === undefined || actual === null || actual === '';
    case 'startsWith': return String(actual ?? '').startsWith(String(expected ?? ''));
    case 'daysAgo': {
      if (!actual) return false;
      const days = Number(expected);
      if (Number.isNaN(days)) return false;
      const timestamp = new Date(actual).getTime();
      if (Number.isNaN(timestamp)) return false;
      const ageDays = (Date.now() - timestamp) / 86400000;
      return ageDays >= days;
    }
    default: return true;
  }
}

export function matchConditions(record, conditions, logic = 'all') {
  const list = Array.isArray(conditions) ? conditions.filter(c => c.field) : [];
  if (!list.length) return true;
  const results = list.map(c => matchCondition(record, c));
  return logic === 'any' ? results.some(Boolean) : results.every(Boolean);
}