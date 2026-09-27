import { query } from '../db/pg.js';
import { readDb } from '../store.js';
import { RESOURCE_MAPPINGS } from '../db/legacy-shape.js';
import { normalizeEmail } from '../helpers.js';

export const SUPPORTED_FREQUENCIES = new Set(['weekly']);

export const SUPPORTED_FORMATS = new Set(['summary', 'detailed']);

// Index matches Date#getUTCDay(), which is also what the BullMQ cron
// `0 8 * * 1` (Monday) is evaluated against.
export const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export const DEFAULT_REPORT_SCHEDULE = {
  enabled: false,
  frequency: 'weekly',
  dayOfWeek: 'monday',
  time: '08:00',
  recipients: [],
  format: 'summary',
  lastSentAt: null,
  includeTable: true,
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class ReportQueryError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ReportQueryError';
    this.status = statusCode;
    this.statusCode = statusCode;
    this.isValidationError = true;
  }
}

export const SUPPORTED_ENTITIES = new Set([
  'deals',
  'leads',
  'contacts',
  'companies',
  'invoices',
  'tickets',
  'expenses',
  'activities',
  'tasks',
  'products',
  'quotes',
  'contracts',
  'orders',
  'campaigns',
  'forms',
  'surveys',
  'survey_responses',
  'surveyResponses',
  'email_lists',
  'emailLists',
]);

export const TABLE_NAME_MAP = {
  deals: 'deals',
  leads: 'leads',
  contacts: 'contacts',
  companies: 'companies',
  invoices: 'invoices',
  tickets: 'tickets',
  expenses: 'expenses',
  activities: 'activities',
  tasks: 'tasks',
  products: 'products',
  quotes: 'quotes',
  contracts: 'contracts',
  orders: 'orders',
  campaigns: 'campaigns',
  forms: 'forms',
  surveys: 'surveys',
  survey_responses: 'survey_responses',
  surveyResponses: 'survey_responses',
  email_lists: 'email_lists',
  emailLists: 'email_lists',
};

function toSnakeCase(str) {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Validates and maps a property name to its safe database column name.
 * Returns null if the property is invalid or not in the entity's whitelist.
 *
 * @param {string} entity
 * @param {string} property
 * @returns {string|null}
 */
export function resolveColumn(entity, property) {
  if (!property || typeof property !== 'string') return null;
  const clean = property.trim();
  if (!/^[a-zA-Z0-9_]+$/.test(clean)) {
    return null;
  }

  if (entity === 'leads') {
    const leadsAliases = {
      firstName: 'first_name',
      lastName: 'last_name',
      companyName: 'company_name',
      ownerId: 'owner_id',
      stage: 'status',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      lastScoredAt: 'last_scored_at',
    };
    const col = leadsAliases[clean] || toSnakeCase(clean);
    const validCols = new Set([
      'id',
      'workspace_id',
      'first_name',
      'last_name',
      'email',
      'phone',
      'company_name',
      'status',
      'source',
      'value',
      'owner_id',
      'score',
      'last_scored_at',
      'created_at',
      'updated_at',
    ]);
    return validCols.has(col) ? col : null;
  }

  if (entity === 'contacts') {
    const contactsAliases = {
      firstName: 'first_name',
      lastName: 'last_name',
      companyId: 'company_id',
      ownerId: 'owner_id',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    };
    const col = contactsAliases[clean] || toSnakeCase(clean);
    const validCols = new Set([
      'id',
      'workspace_id',
      'company_id',
      'first_name',
      'last_name',
      'email',
      'phone',
      'title',
      'owner_id',
      'created_at',
      'updated_at',
    ]);
    return validCols.has(col) ? col : null;
  }

  const mappingKey =
    entity === 'surveyResponses'
      ? 'survey_responses'
      : entity === 'emailLists'
      ? 'email_lists'
      : entity;

  const mapping = RESOURCE_MAPPINGS[mappingKey];
  if (!mapping) return null;

  const col = mapping.toPg?.[clean] || toSnakeCase(clean);
  const validCols = new Set(mapping.columns || []);
  return validCols.has(col) ? col : null;
}

/**
 * Runs aggregation report query using in-memory JSON store.
 */
export async function runJsonStoreReportQuery({
  entity,
  groupBy,
  groupByColumn,
  metric,
  field,
  fieldColumn,
  dateColumn,
  fromDate,
  toDate,
  workspaceId,
}) {
  const db = await readDb();
  const rawList = db[entity] || [];

  const scoped = rawList.filter((item) => {
    const itemWs = item.workspace_id || item.workspaceId || 'default';
    return itemWs === workspaceId;
  });

  const dateFiltered = scoped.filter((item) => {
    if (!fromDate && !toDate) return true;
    const rawDate =
      item[dateColumn] ??
      item.createdAt ??
      item.created_at ??
      item.date ??
      item.updatedAt ??
      item.updated_at;
    if (!rawDate) return false;
    const d = new Date(rawDate).getTime();
    if (isNaN(d)) return false;
    if (fromDate && d < new Date(fromDate).getTime()) return false;
    if (toDate && d > new Date(toDate).getTime()) return false;
    return true;
  });

  const groups = new Map();
  for (const item of dateFiltered) {
    const rawGroup =
      item[groupBy] ??
      item[groupByColumn] ??
      item[toSnakeCase(groupBy)] ??
      '';
    const groupKey = String(rawGroup || '').trim() || 'Unassigned';

    let entry = groups.get(groupKey);
    if (!entry) {
      entry = { group: groupKey, count: 0, _sum: 0, value: 0 };
      groups.set(groupKey, entry);
    }
    entry.count += 1;

    if (metric === 'count') {
      entry.value += 1;
    } else {
      const rawVal =
        item[field] ??
        item[fieldColumn] ??
        item[toSnakeCase(field || '')] ??
        0;
      const num = Number(rawVal) || 0;
      entry._sum += num;
    }
  }

  const results = [];
  for (const entry of groups.values()) {
    if (metric === 'count') {
      results.push({
        group: entry.group,
        value: entry.count,
        count: entry.count,
      });
    } else if (metric === 'sum') {
      results.push({
        group: entry.group,
        value: Number(entry._sum.toFixed(2)),
        count: entry.count,
      });
    } else if (metric === 'avg') {
      const avg = entry.count > 0 ? entry._sum / entry.count : 0;
      results.push({
        group: entry.group,
        value: Math.round(avg * 100) / 100,
        count: entry.count,
      });
    }
  }

  results.sort((a, b) => b.value - a.value || b.count - a.count);
  return results;
}

/**
 * Executes a custom aggregation query across entities.
 *
 * @param {object} params
 * @param {string} params.entity - Target resource/entity
 * @param {string} params.groupBy - Grouping column/field
 * @param {string} params.metric - Aggregation metric: 'count' | 'sum' | 'avg'
 * @param {string} [params.field] - Aggregated value column (required for 'sum' and 'avg')
 * @param {object} [params.dateRange] - Optional { from, to } date range
 * @param {string} [params.dateField] - Date column for filtering (default: 'created_at')
 * @param {string} [params.workspaceId] - Workspace isolation ID
 * @returns {Promise<Array<{ group: string, value: number, count: number }>>}
 */
export async function runReportQuery({
  entity,
  groupBy,
  metric,
  field,
  dateRange,
  dateField,
  workspaceId = 'default',
} = {}) {
  // 1. Validate entity
  if (!entity || typeof entity !== 'string' || !SUPPORTED_ENTITIES.has(entity.trim())) {
    throw new ReportQueryError(
      `Invalid or unsupported entity: '${entity}'. Supported entities are: ${[...SUPPORTED_ENTITIES].join(', ')}`
    );
  }
  const cleanEntity = entity.trim();
  const tableName = TABLE_NAME_MAP[cleanEntity];

  // 2. Validate metric
  if (!metric || typeof metric !== 'string') {
    throw new ReportQueryError("Metric is required and must be one of: count, sum, avg");
  }
  const normalizedMetric = metric.trim().toLowerCase();
  if (!['count', 'sum', 'avg'].includes(normalizedMetric)) {
    throw new ReportQueryError("Invalid metric. Must be one of: count, sum, avg");
  }

  // 3. Validate groupBy
  if (!groupBy || typeof groupBy !== 'string' || !groupBy.trim()) {
    throw new ReportQueryError("groupBy is required");
  }
  const groupByColumn = resolveColumn(cleanEntity, groupBy);
  if (!groupByColumn) {
    throw new ReportQueryError(`Invalid groupBy column '${groupBy}' for entity '${cleanEntity}'`);
  }

  // 4. Validate field for sum and avg
  let fieldColumn = null;
  if (['sum', 'avg'].includes(normalizedMetric)) {
    if (!field || typeof field !== 'string' || !field.trim()) {
      throw new ReportQueryError(`field is required for metric '${normalizedMetric}'`);
    }
    fieldColumn = resolveColumn(cleanEntity, field);
    if (!fieldColumn) {
      throw new ReportQueryError(`Invalid field '${field}' for entity '${cleanEntity}'`);
    }
  }

  // 5. Validate date field and range
  const rawDateField = dateField && typeof dateField === 'string' ? dateField.trim() : 'created_at';
  const dateColumn = resolveColumn(cleanEntity, rawDateField);
  if (!dateColumn) {
    throw new ReportQueryError(`Invalid dateField '${rawDateField}' for entity '${cleanEntity}'`);
  }

  let fromDate = null;
  let toDate = null;
  if (dateRange && typeof dateRange === 'object') {
    if (dateRange.from) {
      const d = new Date(dateRange.from);
      if (isNaN(d.getTime())) {
        throw new ReportQueryError("Invalid dateRange.from format. Expected valid date.");
      }
      fromDate = /^\d{4}-\d{2}-\d{2}$/.test(dateRange.from)
        ? `${dateRange.from}T00:00:00.000Z`
        : d.toISOString();
    }
    if (dateRange.to) {
      const d = new Date(dateRange.to);
      if (isNaN(d.getTime())) {
        throw new ReportQueryError("Invalid dateRange.to format. Expected valid date.");
      }
      toDate = /^\d{4}-\d{2}-\d{2}$/.test(dateRange.to)
        ? `${dateRange.to}T23:59:59.999Z`
        : d.toISOString();
    }
  }

  // 6. Build PostgreSQL query
  let metricSelect = '';
  if (normalizedMetric === 'count') {
    metricSelect = 'COUNT(*)::int AS count, COUNT(*)::int AS value';
  } else if (normalizedMetric === 'sum') {
    metricSelect = `COUNT(*)::int AS count, COALESCE(SUM(CAST(${fieldColumn} AS NUMERIC)), 0)::float AS value`;
  } else if (normalizedMetric === 'avg') {
    metricSelect = `COUNT(*)::int AS count, COALESCE(ROUND(AVG(CAST(${fieldColumn} AS NUMERIC)), 2), 0)::float AS value`;
  }

  const params = [workspaceId || 'default'];
  const conditions = [`(workspace_id = $1 OR ($1 = 'default' AND workspace_id IS NULL))`];

  if (fromDate) {
    params.push(fromDate);
    conditions.push(`${dateColumn} >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate);
    conditions.push(`${dateColumn} <= $${params.length}`);
  }

  const sql = `
    SELECT
      COALESCE(NULLIF(TRIM(CAST(${groupByColumn} AS TEXT)), ''), 'Unassigned') AS "group",
      ${metricSelect}
    FROM ${tableName}
    WHERE ${conditions.join(' AND ')}
    GROUP BY 1
    ORDER BY "value" DESC, "count" DESC
  `;

  // 7. Execute query with graceful JSON fallback
  try {
    const result = await query(sql, params);
    if (result && Array.isArray(result.rows)) {
      if (result.rows.length > 0) {
        return result.rows.map((row) => ({
          group: String(row.group ?? 'Unassigned'),
          value: Number(row.value || 0),
          count: Number(row.count || 0),
        }));
      }

      // Check whether the table in PG has any data for this workspace
      const countCheck = await query(
        `SELECT COUNT(*)::int AS total FROM ${tableName} WHERE workspace_id = $1 OR ($1 = 'default' AND workspace_id IS NULL)`,
        [workspaceId || 'default']
      );
      if (countCheck.rows[0]?.total > 0) {
        // Records exist in PG but didn't match filters -> genuine empty result
        return [];
      }
    }
  } catch (err) {
    // If PG is not running, table is missing, or connection error, proceed to JSON store fallback
  }

  // Fallback to JSON store
  return await runJsonStoreReportQuery({
    entity: cleanEntity,
    groupBy,
    groupByColumn,
    metric: normalizedMetric,
    field,
    fieldColumn,
    dateColumn,
    fromDate,
    toDate,
    workspaceId: workspaceId || 'default',
  });
}

/**
 * Merges a stored schedule with an incoming partial schedule, validating as it
 * goes. Unknown keys are dropped, so a client cannot smuggle state into the
 * persisted record.
 *
 * @param {object} [input] - Incoming schedule fragment
 * @param {object} [existing] - Currently stored schedule
 * @returns {{ schedule: object, error: string|null }}
 */
export function normalizeReportSchedule(input = {}, existing = {}) {
  const base = { ...DEFAULT_REPORT_SCHEDULE, ...(existing || {}) };
  const body = input && typeof input === 'object' ? input : {};
  const schedule = { ...base };

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return { schedule: base, error: 'schedule.enabled must be a boolean' };
    }
    schedule.enabled = body.enabled;
  }

  if (body.frequency !== undefined) {
    const frequency = String(body.frequency || '').trim().toLowerCase();
    if (!SUPPORTED_FREQUENCIES.has(frequency)) {
      return {
        schedule: base,
        error: `Invalid schedule frequency. Must be one of: ${[...SUPPORTED_FREQUENCIES].join(', ')}`,
      };
    }
    schedule.frequency = frequency;
  }

  if (body.dayOfWeek !== undefined) {
    const day = String(body.dayOfWeek || '').trim().toLowerCase();
    const index = WEEKDAYS.indexOf(day);
    if (index < 0) {
      return {
        schedule: base,
        error: `Invalid schedule dayOfWeek. Must be one of: ${WEEKDAYS.join(', ')}`,
      };
    }
    schedule.dayOfWeek = day;
  }

  if (body.time !== undefined) {
    const time = String(body.time || '').trim();
    if (!TIME_PATTERN.test(time)) {
      return { schedule: base, error: 'Invalid schedule time. Expected 24-hour HH:MM' };
    }
    schedule.time = time;
  }

  if (body.format !== undefined) {
    const format = String(body.format || '').trim().toLowerCase();
    if (!SUPPORTED_FORMATS.has(format)) {
      return {
        schedule: base,
        error: `Invalid schedule format. Must be one of: ${[...SUPPORTED_FORMATS].join(', ')}`,
      };
    }
    schedule.format = format;
  }

  if (body.includeTable !== undefined) {
    if (typeof body.includeTable !== 'boolean') {
      return { schedule: base, error: 'schedule.includeTable must be a boolean' };
    }
    schedule.includeTable = body.includeTable;
  }

  if (body.recipients !== undefined) {
    if (!Array.isArray(body.recipients)) {
      return { schedule: base, error: 'schedule.recipients must be an array of email addresses' };
    }
    const recipients = [];
    for (const raw of body.recipients) {
      const email = normalizeEmail(raw);
      if (!email) {
        return { schedule: base, error: `Invalid recipient email address: '${raw}'` };
      }
      if (!recipients.includes(email)) recipients.push(email);
    }
    if (body.enabled === true && recipients.length === 0) {
      return { schedule: base, error: 'At least one recipient is required to enable a schedule' };
    }
    schedule.recipients = recipients;
  }

  return { schedule, error: null };
}

/** True when a schedule is switched on and has somewhere to deliver to. */
export function isScheduleActive(schedule) {
  return Boolean(schedule?.enabled) && Array.isArray(schedule?.recipients) && schedule.recipients.length > 0;
}

/**
 * Whether a weekly schedule falls due on `now`. Compared in UTC so it agrees
 * with the BullMQ cron expression, which is evaluated in UTC.
 *
 * @param {object} schedule
 * @param {Date} [now=new Date()]
 * @returns {boolean}
 */
export function isScheduleDue(schedule, now = new Date()) {
  if (!isScheduleActive(schedule)) return false;
  if (String(schedule.frequency || 'weekly').toLowerCase() !== 'weekly') return false;
  const expected = WEEKDAYS.indexOf(String(schedule.dayOfWeek || 'monday').toLowerCase());
  if (expected < 0) return false;
  return now.getUTCDay() === expected;
}

