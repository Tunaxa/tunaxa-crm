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
  leads: [
    { key: 'name', label: 'Lead name', required: true, type: 'text', maxLength: 255 },
    { key: 'company', label: 'Company', required: false, type: 'text', maxLength: 255 },
    { key: 'email', label: 'Email', required: false, type: 'email', maxLength: 255 },
    { key: 'phone', label: 'Phone', required: false, type: 'tel', maxLength: 30 },
    { key: 'source', label: 'Source', required: false, type: 'text', maxLength: 100 },
    { key: 'status', label: 'Status', required: false, type: 'text', maxLength: 100 },
    { key: 'owner', label: 'Owner', required: false, type: 'text', maxLength: 255 },
    { key: 'value', label: 'Estimated value', required: false, type: 'number' }
  ],
  contacts: [
    { key: 'name', label: 'Contact name', required: true, type: 'text', maxLength: 255 },
    { key: 'role', label: 'Job title', required: false, type: 'text', maxLength: 100 },
    { key: 'company', label: 'Company', required: false, type: 'text', maxLength: 255 },
    { key: 'email', label: 'Email', required: false, type: 'email', maxLength: 255 },
    { key: 'phone', label: 'Phone', required: false, type: 'tel', maxLength: 30 },
    { key: 'owner', label: 'Owner', required: false, type: 'text', maxLength: 255 }
  ],
  companies: [
    { key: 'name', label: 'Company name', required: true, type: 'text', maxLength: 255 },
    { key: 'industry', label: 'Industry', required: false, type: 'text', maxLength: 100 },
    { key: 'website', label: 'Website', required: false, type: 'text', maxLength: 255 },
    { key: 'country', label: 'Country', required: false, type: 'text', maxLength: 100 },
    { key: 'employees', label: 'Employees', required: false, type: 'number' },
    { key: 'owner', label: 'Owner', required: false, type: 'text', maxLength: 255 }
  ],
  deals: [
    { key: 'title', label: 'Deal name', required: true, type: 'text', maxLength: 255 },
    { key: 'company', label: 'Company', required: false, type: 'text', maxLength: 255 },
    { key: 'value', label: 'Value', required: false, type: 'number' },
    { key: 'stage', label: 'Stage', required: false, type: 'text', maxLength: 100 },
    { key: 'owner', label: 'Owner', required: false, type: 'text', maxLength: 255 },
    { key: 'closeDate', label: 'Close date', required: false, type: 'date', maxLength: 20 }
  ]
};

export const NUMERIC_BUILT_INS = {
  deals: ['value'], leads: ['value'], companies: ['employees'],
  campaigns: ['target', 'reached', 'leads'],
  emailLists: ['subscribers'],
  landingPages: ['views', 'conversions'],
  products: ['price', 'cost', 'stock', 'minStock'],
  // `amount` is the legacy key for the `total` column on orders/invoices, so
  // both spellings are coerced - whichever one the client sent.
  orders: ['subtotal', 'tax', 'shipping', 'total', 'amount'],
  invoices: ['amount', 'total', 'tax', 'discount', 'subtotal'],
  expenses: ['amount'],
  employees: ['salary'],
  leaveRequests: ['days'],
  quotes: ['subtotal', 'total', 'amount', 'discount', 'tax'],
  contracts: ['value', 'amount', 'mrr'],
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
  // Postgres-backed resources route unknown fields into custom_fields, so the
  // same numeric built-ins that are not real columns (products.stock,
  // products.minStock, contracts.mrr, ...) have to be coerced inside the bag
  // too - otherwise the API answers the string "100" where the legacy contract
  // answers the number 100.
  const bag = data.custom_fields;
  if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
    for (const key of keys) {
      if (bag[key] === undefined || bag[key] === null || bag[key] === '') continue;
      const number = Number(bag[key]);
      if (!Number.isNaN(number)) bag[key] = number;
    }
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

const STRING_LIKE_TYPES = new Set(['text', 'email', 'tel', 'url', 'textarea']);

// Guarantee a predictable validation shape for the schema endpoint consumed by
// frontend auto-generated forms: required: boolean, type: string, and, for
// string-like inputs, maxLength: number (defaults to 255, 2000 for textareas).
export function normalizeFieldSpec(spec = {}) {
  const type = spec.type || 'text';
  const normalized = { ...spec, required: spec.required === true, type };
  if (STRING_LIKE_TYPES.has(type)) {
    normalized.maxLength = Number(spec.maxLength) || (type === 'textarea' ? 2000 : 255);
  }
  return normalized;
}

export function customFieldSpecs(db, resource) {
  const object = OBJECT_MAP[resource];
  if (!object) return [];
  return (db.customFields || [])
    .filter(field => String(field.object || '').toLowerCase() === object.toLowerCase())
    .map(field => {
      const spec = { key: field.key, label: field.name || field.key, type: CUSTOM_TYPE_MAP[field.type] || 'text', required: Boolean(field.required) };
      const configuredMaxLength = Number(field.maxLength);
      if (Number.isFinite(configuredMaxLength) && configuredMaxLength > 0) spec.maxLength = configuredMaxLength;
      if (field.type === 'Dropdown' && field.options) spec.options = String(field.options).split(',').map(x => x.trim()).filter(Boolean);
      return normalizeFieldSpec(spec);
    });
}

// ── Partial (PATCH) update ────────────────────────────────────────────────
//
// A PATCH body describes a delta, not a replacement. Two things have to hold for
// that to be true, and both are enforced here rather than at each call site:
//
//  1. the fields the server owns never come out of the body. `id` is the primary
//     key, `workspaceId`/`workspace_id` is the tenant boundary - honouring a
//     client-supplied one would move a record into another tenant - and
//     `createdAt`/`created_at` is the audit anchor. `updatedAt` goes too: it is
//     restamped on every write, so a client value could only ever be a lie.
//  2. a key that is absent stays absent. A JSON body cannot express "leave this
//     alone" other than by omission, so a spread of the body over the record has
//     to be the only thing that writes, and it must not carry the keys the body
//     never mentioned.
export const SERVER_OWNED_FIELDS = new Set([
  'id', 'workspaceId', 'workspace_id', 'createdAt', 'created_at', 'updatedAt', 'updated_at',
]);

/**
 * Reduce a PATCH body to the keys that may be applied to an existing record.
 *
 * Drops undefined (absent, and therefore "leave alone"), drops the server-owned
 * fields, and lifts a `customFields` bag into top-level keys - the legacy record
 * shape is flat, and pgToLegacy() flattens the Postgres bag back out to the top
 * level on read, so merging at the top level is what keeps the two in step.
 */
export function partialDelta(body = {}) {
  const delta = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (SERVER_OWNED_FIELDS.has(key) || value === undefined) continue;
    if (key === 'customFields' || key === 'custom_fields') {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [customKey, customValue] of Object.entries(value)) {
          if (customValue !== undefined) delta[customKey] = customValue;
        }
      }
      continue;
    }
    delta[key] = value;
  }
  return delta;
}

/**
 * Apply a delta to a stored record, leaving every key the delta does not name
 * exactly as it was.
 *
 * A plain top-level spread is already the shallow merge the flat legacy shape
 * needs. The one nested object in that shape is the `customFields` bag (rows
 * written before the Postgres cutover keep it), so it gets an explicit merge
 * rather than a replacement - otherwise editing one custom field drops the rest.
 */
export function applyPartialUpdate(existing = {}, delta = {}) {
  const merged = { ...existing, ...delta };
  if (delta.customFields && typeof delta.customFields === 'object') {
    merged.customFields = {
      ...(existing.customFields && typeof existing.customFields === 'object' ? existing.customFields : {}),
      ...delta.customFields,
    };
  }
  if (delta.custom_fields && typeof delta.custom_fields === 'object') {
    merged.custom_fields = {
      ...(existing.custom_fields && typeof existing.custom_fields === 'object' ? existing.custom_fields : {}),
      ...delta.custom_fields,
    };
  }
  return merged;
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
  // `forms` and `tickets` are deliberately absent even though they are served
  // from Postgres (see PG_RESOURCES in db/legacy-shape.js). Their dedicated
  // handlers in routes/forms.js and routes/tickets.js are registered before the
  // generic /api/:resource handler, so listing them here would not add anything
  // those handlers do not already cover, and for forms it would actively break
  // them: routes/forms.js owns `GET /api/forms/:permalink` (public, no auth),
  // which would shadow the generic `GET /api/forms/export.csv` and
  // `GET /api/forms/:id` and answer them as an unknown permalink.
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
