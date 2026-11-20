import { id } from "../helpers.js";

export const IMPORT_RESOURCES = ["contacts", "leads", "companies", "deals"];
export const MAX_IMPORT_ROWS = 1000;
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_ERROR_REPORT_ENTRIES = 200;
export const ERROR_REPORT_TTL_MS = 30 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const POSITIVE_NUMBER_FIELDS = { deals: ["value"] };

export const FORBIDDEN_MAPPING_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "workspaceid",
  "workspace_id",
]);

const FIELD_ALIASES = {
  email: ["e-mail", "work email", "email address", "e mail"],
  phone: ["telephone", "mobile", "cell", "cell phone", "phone number", "tel"],
  name: [
    "full name",
    "fullname",
    "contact name",
    "lead name",
    "company name",
    "organization name",
    "account name",
  ],
  firstName: ["first name", "given name", "givenname"],
  lastName: ["last name", "surname", "family name", "familyname"],
  title: ["deal name", "deal", "deal title", "job title", "position"],
  companyName: ["company", "organization", "organisation", "account"],
  company: ["organisation", "account"],
  companyId: ["company id"],
  contactId: ["contact id"],
  pipelineId: ["pipeline", "pipeline id"],
  value: ["amount", "deal value", "estimated value", "price"],
  stage: ["pipeline stage", "deal stage"],
  status: ["lead status"],
  source: ["lead source"],
  industry: ["sector"],
  country: ["location"],
  employees: ["employee count", "number of employees", "headcount"],
  closeDate: ["expected close date", "close date"],
};

export class ImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ImportError";
    this.status = status;
  }
}

function normalizeToken(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isForbiddenMappingKey(value) {
  return FORBIDDEN_MAPPING_KEYS.has(normalizeToken(value));
}

function mappableFields(schema) {
  return (schema?.fields || []).filter(
    (field) =>
      !field.readOnly &&
      field.name !== "id" &&
      !isForbiddenMappingKey(field.name),
  );
}

function isAutoMatchable(field) {
  return field.type !== "relation" && !/Id$/.test(field.name);
}

function addToken(lookup, raw, fieldName) {
  const token = normalizeToken(raw);
  if (!token || lookup.has(token)) return;
  lookup.set(token, fieldName);
}

export function parseCsv(text) {
  if (typeof text !== "string") {
    throw new ImportError("CSV content must be a string");
  }
  let input = text;
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);

  const records = [];
  let field = "";
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
      if (field.length === 0) {
        inQuotes = true;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === ",") {
      record.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      if (input[i + 1] === "\n") i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
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

  const nonEmpty = records.filter((cells) =>
    cells.some((cell) => cell.trim() !== ""),
  );
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = nonEmpty[0].map((cell) => cell.trim());
  const rows = nonEmpty.slice(1).map((cells, position) => ({
    index: position + 1,
    values: cells.map((cell) => cell.trim()),
  }));
  return { headers, rows };
}

export function buildDefaultMapping(headers, schema) {
  const fields = schema?.fields ? schema.fields.filter((f) => !f.readOnly) : [];
  const lookup = new Map();
  for (const field of fields) {
    if (isForbiddenMappingKey(field.name) || !isAutoMatchable(field)) continue;
    addToken(lookup, field.name, field.name);
    addToken(lookup, field.label, field.name);
    addToken(lookup, field.mapsTo, field.name);
  }
  for (const field of fields) {
    if (isForbiddenMappingKey(field.name) || !isAutoMatchable(field)) continue;
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

export function resolveMapping(mapping, headers, schema) {
  if (mapping === undefined || mapping === null) {
    const detected = buildDefaultMapping(headers, schema);
    return toAssignments(detected, headers, schema);
  }
  if (typeof mapping !== "object" || Array.isArray(mapping)) {
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
    if (typeof target !== "string" || target.trim() === "") {
      throw new ImportError(`Mapping for "${source}" must be a field name`);
    }
    if (isForbiddenMappingKey(source) || isForbiddenMappingKey(target)) {
      throw new ImportError(`Mapping refers to a forbidden field "${target}"`);
    }
    const index = headerIndex.get(normalizeToken(source));
    if (index === undefined) {
      throw new ImportError(
        `Mapping refers to an unknown CSV column "${source}"`,
      );
    }
    const field = byName.get(target.trim().toLowerCase());
    if (!field) {
      throw new ImportError(`Unknown or read-only target field "${target}"`);
    }
    assignments.push({ index, field });
  }
  return assignments;
}

export function mapRow(row, assignments) {
  const record = {};
  for (const { index, field } of assignments) {
    const value = row.values[index];
    if (value === undefined) continue;
    record[field] = value;
  }
  return record;
}

export function validateRecord(record, schema, resource) {
  const errors = [];
  const positive = POSITIVE_NUMBER_FIELDS[resource] || [];
  for (const field of mappableFields(schema)) {
    const raw = record[field.name];
    const empty =
      raw === undefined || raw === null || String(raw).trim() === "";
    if (field.required && empty) {
      errors.push(`${field.label} is required`);
      continue;
    }
    if (empty) continue;
    const value = String(raw).trim();

    if (field.type === "email") {
      if (!EMAIL_RE.test(value)) {
        errors.push(`${field.label} must be a valid email address`);
      }
    } else if (field.type === "number" || field.type === "currency") {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        errors.push(`${field.label} must be a number`);
      } else if (positive.includes(field.name) && number <= 0) {
        errors.push(`${field.label} must be a positive number`);
      }
    } else if (field.type === "date" || field.type === "datetime") {
      if (Number.isNaN(Date.parse(value))) {
        errors.push(`${field.label} must be a valid date`);
      }
    } else if (
      field.type === "select" &&
      Array.isArray(field.options) &&
      field.options.length > 0
    ) {
      const allowed = field.options.map((option) =>
        String(option.value ?? option).toLowerCase(),
      );
      if (!allowed.includes(value.toLowerCase())) {
        const labels = field.options.map((option) =>
          String(option.value ?? option),
        );
        errors.push(`${field.label} must be one of: ${labels.join(", ")}`);
      }
    }
  }
  return errors;
}

const escapeCell = (value) => {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function buildErrorCsv(headers, failedRows) {
  const lines = [[...headers, "_errors"].map(escapeCell).join(",")];
  for (const row of failedRows) {
    const cells = headers.map((_, index) =>
      row.values[index] === undefined ? "" : row.values[index],
    );
    cells.push(row.errors.join("; "));
    lines.push(cells.map(escapeCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function createErrorReportStore({
  ttlMs = ERROR_REPORT_TTL_MS,
  maxEntries = MAX_ERROR_REPORT_ENTRIES,
} = {}) {
  const reports = new Map();
  return {
    save(csv, meta = {}) {
      const reportId = id("importError");
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

export async function runImport({
  csv,
  resource,
  schema,
  mapping,
  dryRun = true,
  failureStrategy = "continue",
  persist,
} = {}) {
  if (typeof csv !== "string" || csv.trim() === "") {
    throw new ImportError("CSV content is required");
  }
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) {
    throw new ImportError(
      `CSV payload exceeds the ${Math.floor(MAX_CSV_BYTES / 1024 / 1024)} MB limit`,
      413,
    );
  }
  const { headers, rows } = parseCsv(csv);
  if (headers.length === 0)
    throw new ImportError("CSV must include a header row");
  if (rows.length === 0) throw new ImportError("No data rows found in CSV");
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new ImportError(`Maximum ${MAX_IMPORT_ROWS} rows per import`);
  }

  const assignments = resolveMapping(mapping, headers, schema);
  if (assignments.length === 0) {
    throw new ImportError(
      "No CSV columns could be mapped to fields; provide an explicit `mapping`",
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
      const message = `Could not be saved: ${err.message}`;
      errors.push({ row: row.index, errors: [message] });
      failedRows.push({ values: row.values, errors: [message] });
      if (failureStrategy === "abort") break;
    }
  }

  return {
    totalRows: rows.length,
    validRows,
    invalidRows: failedRows.length,
    importedCount: summaryImported(importedCount),
    errorCount: errors.length,
    errors,
    errorCsv: failedRows.length > 0 ? buildErrorCsv(headers, failedRows) : "",
  };
}

function summaryImported(importedCount) {
  return importedCount;
}
