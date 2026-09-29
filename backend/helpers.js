import crypto from 'node:crypto';

export const now = () => new Date().toISOString();
export const id = prefix => `${prefix}_${crypto.randomUUID()}`;
export const publicUser = user => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  preferences: user.preferences || {
    theme: 'light',
    sidebarCollapsed: false,
    pageSize: 25,
  },
});
export const auditEntry = ({ action, actor, createdAt = now(), req, resourceId = '' }) => ({
  id: id('audit'),
  action,
  actor,
  createdAt,
  ip: req?.ip || '',
  userAgent: req?.headers?.['user-agent'] || '',
  resourceId,
});

export const hashPassword = password => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

export const verifyPassword = (password, stored) => {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const storedBuffer = Buffer.from(hash, 'hex');
  if (candidate.length !== storedBuffer.length) return false;
  return crypto.timingSafeEqual(candidate, storedBuffer);
};

export const CUSTOM_TYPE_MAP = { Text: 'text', Number: 'number', Date: 'date', Dropdown: 'select', MultiSelect: 'multiSelect', Checkbox: 'checkbox', Currency: 'currency', File: 'file', Textarea: 'textarea', Percent: 'number' };
export const OBJECT_MAP = { leads: 'Lead', contacts: 'Contact', companies: 'Company', deals: 'Deal' };
export const BUILT_IN_FIELDS = {
  leads: [{ key: 'name', label: 'Lead name' }, { key: 'company', label: 'Company' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }, { key: 'source', label: 'Source' }, { key: 'status', label: 'Status' }, { key: 'owner', label: 'Owner' }, { key: 'value', label: 'Estimated value' }],
  contacts: [{ key: 'name', label: 'Contact name' }, { key: 'role', label: 'Job title' }, { key: 'company', label: 'Company' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }, { key: 'owner', label: 'Owner' }],
  companies: [{ key: 'name', label: 'Company name' }, { key: 'industry', label: 'Industry' }, { key: 'website', label: 'Website' }, { key: 'country', label: 'Country' }, { key: 'employees', label: 'Employees' }, { key: 'owner', label: 'Owner' }],
  deals: [{ key: 'title', label: 'Deal name' }, { key: 'company', label: 'Company' }, { key: 'value', label: 'Value' }, { key: 'stage', label: 'Stage' }, { key: 'owner', label: 'Owner' }, { key: 'closeDate', label: 'Close date' }]
};

export const NUMERIC_BUILT_INS = {
  deals: ['value'], leads: ['value'], companies: ['employees'],
  campaigns: ['target', 'reached', 'leads'],
  emailLists: ['subscribers'],
  landingPages: ['views', 'conversions'],
  products: ['price', 'cost', 'stock', 'minStock'],
  orders: ['subtotal', 'tax', 'shipping', 'total'],
  invoices: ['amount', 'tax'],
  expenses: ['amount'],
  employees: ['salary'],
  leaveRequests: ['days'],
  quotes: ['total', 'discount'],
  contracts: ['value', 'mrr'],
  marketingEmails: ['recipients', 'opens', 'clicks', 'conversions'],
  marketingEvents: ['capacity', 'registrations'],
  goals: ['target', 'current'],
  surveys: ['targetScore'],
  surveyResponses: ['score'],
  webhookEndpoints: ['requestCount']
};

export function coerceBuiltIns(resource, data) {
  const keys = NUMERIC_BUILT_INS[resource];
  if (!keys) return data;
  for (const key of keys) {
    if (data[key] === undefined || data[key] === null || data[key] === '') continue;
    const number = Number(data[key]);
    if (!Number.isNaN(number)) data[key] = number;
  }
  return data;
}

export function coerceCustomFields(db, resource, data) {
  const object = OBJECT_MAP[resource];
  if (!object) return data;
  const custom = (db.customFields || []).filter(field => String(field.object || '').toLowerCase() === object.toLowerCase());
  for (const field of custom) {
    const key = field.key;
    if (!(key in data) || data[key] === null || data[key] === undefined || data[key] === '') continue;
    if (field.type === 'Number' || field.type === 'Currency' || field.type === 'Percent') {
      const number = Number(data[key]);
      data[key] = Number.isNaN(number) ? 0 : number;
    }
    if (field.type === 'Checkbox') data[key] = Boolean(data[key]);
    if (field.type === 'MultiSelect') {
      data[key] = Array.isArray(data[key]) ? data[key] : String(data[key]).split(',').map(x => x.trim()).filter(Boolean);
    }
  }
  return data;
}

export function customFieldSpecs(db, resource) {
  const object = OBJECT_MAP[resource];
  if (!object) return [];
  return (db.customFields || [])
    .filter(field => String(field.object || '').toLowerCase() === object.toLowerCase())
    .map(field => {
      const spec = { key: field.key, label: field.name || field.key, type: CUSTOM_TYPE_MAP[field.type] || 'text', required: Boolean(field.required) };
      if (field.type === 'Dropdown' && field.options) spec.options = String(field.options).split(',').map(x => x.trim()).filter(Boolean);
      return spec;
    });
}

export function completeCall(db, call, { endedAt, duration, actorName } = {}) {
  const completedAt = endedAt || now();
  call.status = 'Completed';
  call.duration = Math.max(0, Number(duration || call.duration || 0));
  call.endedAt = completedAt;
  call.updatedAt = now();

  let activity = db.activities.find(item => item.callId === call.id);
  if (!activity) {
    activity = {
      id: id('activity'),
      title: `Call with ${call.contact || call.phone || 'unknown number'}`,
      type: 'Call',
      contact: call.contact || '',
      phone: call.phone || '',
      notes: `${call.direction || 'Outbound'} call completed · ${call.duration}s`,
      date: completedAt.slice(0, 10),
      callId: call.id,
      createdAt: completedAt,
      updatedAt: completedAt
    };
    db.activities.unshift(activity);
  }

  let recording = null;
  if (db.settings.callRecording !== false) {
    recording = db.recordings.find(item => item.callId === call.id) || null;
    if (!recording) {
      recording = {
        id: id('recording'),
        title: `Call recording · ${call.contact || call.phone || 'Unknown number'}`,
        contact: call.contact || '',
        phone: call.phone || '',
        duration: call.duration,
        transcript: '',
        summary: '',
        fileUrl: '',
        originalName: '',
        mimeType: '',
        mediaStatus: 'Awaiting provider media',
        source: 'Call',
        callId: call.id,
        createdAt: completedAt,
        updatedAt: completedAt
      };
      db.recordings.unshift(recording);
    }
    call.recordingId = recording.id;
  }

  db.audit.unshift({ id: id('audit'), action: `Completed call ${call.phone || call.id}`, actor: actorName || 'System', createdAt: now() });
  return { call, activity, recording };
}

export const normalizeEmail = email => {
  if (email === null || email === undefined) return null;
  let value = String(email).trim();
  if (!value) return null;
  const angle = value.match(/<([^<>]+)>/);
  if (angle) value = angle[1].trim();
  else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    value = value.slice(1, -1).trim();
  value = value.toLowerCase();
  if (!value || /\s/.test(value)) return null;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!local || !domain || !domain.includes('.')) return null;
  return value;
};

export const resources = new Set([
  'leads','contacts','companies','deals','tasks','activities','workflows','calls','recordings','messages','templates','sequences','team','customFields','audit',
  'campaigns','emailLists','landingPages',
  'products','orders',
  'invoices','expenses',
  'employees','leaveRequests','attendance',
  'quotes','contracts','marketingEmails','marketingEvents','goals','surveys','surveyResponses',
  'webhookEndpoints','webhookDeliveries'
]);

// Normalize a value so mixed types can be compared safely: numbers/booleans
// and ISO date strings compare numerically, everything else falls back to a
// case-insensitive string comparison.
const toSortValue = value => {
  if (typeof value === 'number') return { kind: 'number', value };
  if (typeof value === 'boolean') return { kind: 'number', value: value ? 1 : 0 };
  if (value instanceof Date) return { kind: 'number', value: value.getTime() };
  if (typeof value === 'string' && value.trim() !== '') {
    if (!Number.isNaN(Number(value))) return { kind: 'number', value: Number(value) };
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return { kind: 'number', value: time };
    return { kind: 'string', value: value.toLowerCase() };
  }
  return { kind: 'string', value: String(value ?? '').toLowerCase() };
};

const compareValues = (a, b) => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1; // missing values sort last
  if (b === null || b === undefined) return -1;
  const left = toSortValue(a);
  const right = toSortValue(b);
  if (left.kind === 'number' && right.kind === 'number') return left.value - right.value;
  if (left.kind === 'string' && right.kind === 'string') {
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  }
  return String(left.value).localeCompare(String(right.value));
};

/**
 * Apply the standard list contract to an in-memory collection:
 *   ?q=        case-insensitive substring match over the serialized record
 *   ?sortBy=   field to sort by (default "createdAt")
 *   ?sortDir=  "asc" | "desc" (default "desc")
 *   ?page=     page number, 1-based (default 1)
 *   ?limit=    page size, 1..100 (default 25)
 *
 * Always returns { data, total, page, limit }. Route-specific filters should
 * be applied to `items` before calling this helper.
 */
export const paginateAndSort = (items = [], query = {}) => {
  const rows = Array.isArray(items) ? items : [];

  const q = String(query.q || '').toLowerCase().trim();
  let filtered = q
    ? rows.filter(item => JSON.stringify(item).toLowerCase().includes(q))
    : rows;

  const sortBy = String(query.sortBy || 'createdAt');
  const sortDir = String(query.sortDir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  const direction = sortDir === 1 ? 1 : -1;

  filtered = [...filtered].sort((a, b) => {
    const av = a ? a[sortBy] : undefined;
    const bv = b ? b[sortBy] : undefined;
    return direction * compareValues(av, bv);
  });

  const page = Math.max(1, parseInt(String(query.page), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit), 10) || 25));
  const start = (page - 1) * limit;

  return { data: filtered.slice(start, start + limit), total: filtered.length, page, limit };
};
