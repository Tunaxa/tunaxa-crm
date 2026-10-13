// CSV import service (P2-BE2-04).
//
// Pure, transport-agnostic engine behind `POST /api/import/:resource`:
//
//   * `parseCsv`            - RFC-4180-ish reader (BOM, quoted commas, escaped
//                             quotes, embedded newlines, CRLF/LF).
//   * `buildDefaultMapping` - case-insensitive auto-mapping of CSV headers onto
//                             the reflected resource schema (`services/schema.js`).
//   * `resolveMapping`      - validates an explicit `{ "CSV Header": "field" }`
//                             mapping, rejecting unknown columns/fields.
//   * `validateRecord`      - schema-driven row validation (required, email,
//                             numeric/positive, date, select options).
//   * `runImport`           - one pass over the rows that produces metrics and
//                             an error CSV. When `dryRun` is true `persist` is
//                             never called, so the caller can guarantee zero
//                             writes to the database or JSON store.
//
// Nothing here touches Express, Postgres or the JSON store, which keeps the
// dry-run isolation guarantee structural rather than a matter of discipline.

import { id } from '../helpers.js';

export const IMPORT_RESOURCES = ['contacts', 'leads', 'companies', 'deals'];
export const MAX_IMPORT_ROWS = 1000;
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_ERROR_REPORT_ENTRIES = 200;
export const ERROR_REPORT_TTL_MS = 30 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Per-resource numeric fields that must be strictly positive when present.
// Deal value is the canonical example: a negative or zero pipeline amount is
// almost always a bad export rather than a legitimate record.
const POSITIVE_NUMBER_FIELDS = { deals: ['value'] };

// Friendly aliases layered on top of the schema's own name/label/mapsTo so
// "Work Email", "Full Name" or "Amount" land on the right field without the
// caller having to spell out a mapping. Keyed by the schema field name; only
// consulted when that field exists on the target resource.
const FIELD_ALIASES = {
  email: ['e-mail', 'work email', 'email address', 'e mail'],
  phone: ['telephone', 'mobile', 'cell', 'cell phone', 'phone number', 'tel'],
  name: [
    'full name',
    'fullname',
    'contact name',
    'lead name',
    'company name',
    'organization name',
    'account name',
  ],
  firstName: ['first name', 'given name', 'givenname'],
  lastName: ['last name', 'surname', 'family name', 'familyname'],
  title: ['deal name', 'deal', 'deal title', 'job title', 'position'],
  companyName: ['company', 'organization', 'organisation', 'account'],
  company: ['organisation', 'account'],
  companyId: ['company id'],
  contactId: ['contact id'],
  pipelineId: ['pipeline'],
  value: ['amount', 'deal value', 'estimated value', 'price'],
  stage: ['pipeline stage', 'deal stage'],
  status: ['lead status'],
  source: ['lead source'],
  industry: ['sector'],
  country: ['location'],
  employees: ['employee count', 'number of employees', 'headcount'],
  closeDate: ['expected close date', 'close date'],
};

/** Error carrying the HTTP status the route should surface. */
export class ImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ImportError';
    this.status = status;
  }
}

/** Strip case and punctuation so "Work Email", "work_email" and "WorkEmail" match. */
function normalizeToken(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Fields a caller may set from a CSV: everything except the system-managed
// columns (`id`, timestamps). Relation/id fields stay mappable explicitly but
// are excluded from automatic matching so a "Company" text column never lands
// a company *name* in a `*_id` column.
function mappableFields(schema) {
  return (schema?.fields || []).filter(
    (field) => !field.readOnly && field.name !== 'id',
  );
}

function isAutoMatchable(field) {
  return field.type !== 'relation' && !/Id$/.test(field.name);
}

function addToken(lookup, raw, fieldName) {
  const token = normalizeToken(raw);
  if (!token || lookup.has(token)) return;
  lookup.set(token, fieldName);
}

/**
 * Read a CSV string into `{ headers, rows }`.
 *
 * `rows[i]` is `{ index, values }` where `index` is the 1-based data-row number
 * (the header is not counted) and `values` are the raw cells in header order.
 * A row whose length does not match the header is kept as-is; `runImport`
 * flags it rather than silently dropping it.
 */
export function parseCsv(text) {
  if (typeof text !== 'string') {
    throw new ImportError('CSV content must be a string');
  }
  let input = text;
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);

  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Only a quote at the start of a field opens a quoted section; elsewhere
      // it is a literal (lenient with malformed exports).
      if (field.length === 0) {
        inQuotes = true;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === ',') {
      record.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (input[i + 1] === '\n') i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((cells) => cells.some((cell) => cell.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = nonEmpty[0].map((cell) => cell.trim());
  const rows = nonEmpty.slice(1).map((cells, position) => ({
    index: position + 1,
    values: cells.map((cell) => cell.trim()),
  }));
  return { headers, rows };
}

/**
 * Intelligent default mapping: match each header to a schema field by name,
 * label, `mapsTo` or a friendly alias, all case/punctuation-insensitively.
 * Relation and `*Id` fields are skipped (see `isAutoMatchable`); a name or
 * label always beats an alias, and the first claim on a token wins.
 */
export function buildDefaultMapping(headers, schema) {
  const fields = schema?.fields ? schema.fields.filter((f) => !f.readOnly) : [];
  const lookup = new Map();
  for (const field of fields) {
    if (!isAutoMatchable(field)) continue;
    addToken(lookup, field.name, field.name);
    addToken(lookup, field.label, field.name);
    addToken(lookup, field.mapsTo, field.name);
  }
  for (const field of fields) {
    if (!isAutoMatchable(field)) continue;
    for (const alias of FIELD_ALIASES[field.name] || []) {
      addToken(lookup, alias, field.name);
    }
  }

  const mapping = {};
  for (const header of headers) {
    const token = normalizeToken(header);
    if (!token || !lookup.has(token) || header in mapping) continue;
    mapping[header] = lookup.get(token);
  }
  return mapping;
}

/**
 * Turn an explicit (or default) mapping into `[{ index, field }]` assignments.
 * Throws `ImportError(400)` for a mapping that names a column the CSV does not
 * have or a field the resource does not expose (including read-only fields).
 */
export function resolveMapping(mapping, headers, schema) {
  if (mapping === undefined || mapping === null) {
    const detected = buildDefaultMapping(headers, schema);
    return toAssignments(detected, headers, schema);
  }
  if (typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new ImportError(
      '`mapping` must be an object of { "CSV Header": "fieldName" }',
    );
  }
  return toAssignments(mapping, headers, schema);
}

function toAssignments(mapping, headers, schema) {
  const headerIndex = new Map();
  headers.forEach((header, index) => {
    const token = normalizeToken(header);
    if (token && !headerIndex.has(token)) headerIndex.set(token, index);
  });

  const byName = new Map();
  for (const field of mappableFields(schema)) {
    byName.set(field.name.toLowerCase(), field.name);
  }

  const assignments = [];
  for (const [source, target] of Object.entries(mapping)) {
    if (typeof target !== 'string' || target.trim() === '') {
      throw new ImportError(`Mapping for "${source}" must be a field name`);
    }
    const index = headerIndex.get(normalizeToken(source));
    if (index === undefined) {
      throw new ImportError(`Mapping refers to an unknown CSV column "${source}"`);
    }
    const field = byName.get(target.trim().toLowerCase());
    if (!field) {
      throw new ImportError(`Unknown or read-only target field "${target}"`);
    }
    assignments.push({ index, field });
  }
  return assignments;
}

/** Project one parsed row onto a record keyed by public field names. */
export function mapRow(row, assignments) {
  const record = {};
  for (const { index, field } of assignments) {
    const value = row.values[index];
    if (value === undefined) continue;
    record[field] = value;
  }
  return record;
}

/**
 * Validate one mapped record against the reflected schema. Returns an array of
 * human-readable messages (empty when the row is valid).
 */
export function validateRecord(record, schema, resource) {
  const errors = [];
  const positive = POSITIVE_NUMBER_FIELDS[resource] || [];
  for (const field of mappableFields(schema)) {
    const raw = record[field.name];
    const empty = raw === undefined || raw === null || String(raw).trim() === '';
    if (field.required && empty) {
      errors.push(`${field.label} is required`);
      continue;
    }
    if (empty) continue;
    const value = String(raw).trim();

    if (field.type === 'email') {
      if (!EMAIL_RE.test(value)) {
        errors.push(`${field.label} must be a valid email address`);
      }
    } else if (field.type === 'number' || field.type === 'currency') {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        errors.push(`${field.label} must be a number`);
      } else if (positive.includes(field.name) && number <= 0) {
        errors.push(`${field.label} must be a positive number`);
      }
    } else if (field.type === 'date' || field.type === 'datetime') {
      if (Number.isNaN(Date.parse(value))) {
        errors.push(`${field.label} must be a valid date`);
      }
    } else if (
      field.type === 'select' &&
      Array.isArray(field.options) &&
      field.options.length > 0
    ) {
      const allowed = field.options.map((option) =>
        String(option.value ?? option).toLowerCase(),
      );
      if (!allowed.includes(value.toLowerCase())) {
        const labels = field.options.map((option) => String(option.value ?? option));
        errors.push(`${field.label} must be one of: ${labels.join(', ')}`);
      }
    }
  }
  return errors;
}

const escapeCell = (value) => {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * Render the failed rows in their original column layout with an appended
 * `_errors` column. Pure and download-ready (`text/csv`).
 */
export function buildErrorCsv(headers, failedRows) {
  const lines = [[...headers, '_errors'].map(escapeCell).join(',')];
  for (const row of failedRows) {
    const cells = headers.map((_, index) =>
      row.values[index] === undefined ? '' : row.values[index],
    );
    cells.push(row.errors.join('; '));
    lines.push(cells.map(escapeCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function createErrorReportStore({
  ttlMs = ERROR_REPORT_TTL_MS,
  maxEntries = MAX_ERROR_REPORT_ENTRIES,
} = {}) {
  const reports = new Map();
  return {
    save(csv, meta = {}) {
      const reportId = id('importError');
      reports.set(reportId, { csv, createdAt: Date.now(), ...meta });
      while (reports.size > maxEntries) {
        const oldest = reports.keys().next().value;
        reports.delete(oldest);
      }
      return reportId;
    },
    get(reportId) {
      const report = reports.get(reportId);
      if (!report) return null;
      if (Date.now() - report.createdAt > ttlMs) {
        reports.delete(reportId);
        return null;
      }
      return report;
    },
    get size() {
      return reports.size;
    },
    clear() {
      reports.clear();
    },
  };
}

/**
 * Run a complete import. Returns metrics plus the error CSV; never persists
 * when `dryRun` is true. `persist(record)` is supplied by the caller so this
 * function stays free of database coupling.
 */
export async function runImport({
  csv,
  resource,
  schema,
  mapping,
  dryRun = true,
  failureStrategy = 'continue',
  persist,
} = {}) {
  if (typeof csv !== 'string' || csv.trim() === '') {
    throw new ImportError('CSV content is required');
  }
  if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
    throw new ImportError(
      `CSV payload exceeds the ${Math.floor(MAX_CSV_BYTES / 1024 / 1024)} MB limit`,
      413,
    );
  }
  const { headers, rows } = parseCsv(csv);
  if (headers.length === 0) throw new ImportError('CSV must include a header row');
  if (rows.length === 0) throw new ImportError('No data rows found in CSV');
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new ImportError(`Maximum ${MAX_IMPORT_ROWS} rows per import`);
  }

  const assignments = resolveMapping(mapping, headers, schema);
  if (assignments.length === 0) {
    throw new ImportError(
      'No CSV columns could be mapped to fields; provide an explicit `mapping`',
    );
  }

  const errors = [];
  const failedRows = [];
  let validRows = 0;
  let importedCount = 0;

  for (const row of rows) {
    const record = mapRow(row, assignments);
    const rowErrors = validateRecord(record, schema, resource);
    if (row.values.length !== headers.length) {
      rowErrors.unshift(
        `Row has ${row.values.length} column(s) but the header defines ${headers.length}`,
      );
    }
    if (rowErrors.length > 0) {
      errors.push({ row: row.index, errors: rowErrors });
      failedRows.push({ values: row.values, errors: rowErrors });
      continue;
    }

    validRows += 1;
    if (dryRun) continue;

    try {
      await persist(record);
      importedCount += 1;
    } catch (err) {
      // Never echo the persistence error back to the client: a driver/SQL
      // error carries table, column and filesystem detail. Keep the real
      // cause in the server log and return a sanitized reason.
      console.error(`[import] failed to persist a ${resource} row:`, err);
      const message = 'Could not be saved';
      errors.push({ row: row.index, errors: [message] });
      failedRows.push({ values: row.values, errors: [message] });
      if (failureStrategy === 'abort') break;
    }
  }

  return {
    totalRows: rows.length,
    validRows,
    invalidRows: failedRows.length,
    importedCount,
    errorCount: errors.length,
    errors,
    errorCsv: failedRows.length > 0 ? buildErrorCsv(headers, failedRows) : '',
  };
}
