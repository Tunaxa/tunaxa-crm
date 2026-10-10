// Schema reflection service (P2-BE1-03).
//
// Client applications read this metadata to build CRUD forms, validation and
// data tables without hardcoding a field list per view. The design is a hybrid:
//
//   * The static registry below owns the parts that are a product decision and
//     cannot be inferred from a table: the camelCase contract key, the display
//     label, the input type (string vs text vs email vs datetime), and the
//     read-only classification of system-managed fields.
//   * `buildResourceSchema` layers in the parts the application already owns and
//     must not be duplicated: ticket Kanban stages (`services/ticket-stages.js`),
//     ticket SLA priorities (`services/sla.js`), deal stage and pipeline
//     vocabulary (`db.pipelineDefinitions`), the workspace currency, and the
//     per-object custom fields stored in the JSON workspace.
//
// Nothing here touches Express or the database directly, so the same contract
// is unit-testable and can be reused by a future GraphQL/OpenAPI surface.

import { RECOGNIZED_STAGES } from './ticket-stages.js';
import { DEFAULT_SLA_TARGETS } from './sla.js';
import { DEFAULT_PIPELINE } from '../routes/pipeline.js';
import { customFieldSpecs } from '../helpers.js';

// Vocabulary the entities actually use. Kept next to the field that renders it
// rather than scattered across the route files.
const TICKET_SOURCES = ['Email', 'Phone', 'Chat', 'Web', 'Portal', 'Other'];
const ACTIVITY_TYPES = [
  'Call',
  'Email',
  'Meeting',
  'Note',
  'Task',
  'Lead Score',
  'SMS',
];
const ACTIVITY_DIRECTIONS = ['Inbound', 'Outbound'];
const LEAD_STATUSES = ['New', 'Contacted', 'Qualified', 'Nurture', 'Lost'];
const TASK_STATUSES = ['Open', 'In Progress', 'Completed', 'Cancelled'];
const TASK_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const QUOTE_STATUSES = [
  'Draft',
  'Sent',
  'Accepted',
  'Declined',
  'Expired',
  'Signed',
];

/** Convert a plain value list into the `{ label, value }` option contract. */
function options(values) {
  return values.map((value) => ({ label: String(value), value }));
}

/**
 * Ticket priorities come from the SLA engine so the reflection surface can never
 * drift from the tiers the due-date computation actually recognises. The keys
 * are lower-case; the stored ticket value is title-case.
 */
function slaPriorityOptions() {
  return Object.keys(DEFAULT_SLA_TARGETS).map((key) => {
    const label = key.charAt(0).toUpperCase() + key.slice(1);
    return { label, value: label };
  });
}

// Fields every resource shares. `readOnly` marks them as system-managed: a form
// generator must render them (tables need id/createdAt) but never submit them.
const SYSTEM_FIELDS = {
  id: {
    name: 'id',
    label: 'ID',
    type: 'string',
    required: false,
    readOnly: true,
  },
  createdAt: {
    name: 'createdAt',
    label: 'Created At',
    type: 'datetime',
    required: false,
    readOnly: true,
    mapsTo: 'created_at',
  },
  updatedAt: {
    name: 'updatedAt',
    label: 'Updated At',
    type: 'datetime',
    required: false,
    readOnly: true,
    mapsTo: 'updated_at',
  },
};

/**
 * The static field registry. Keys are the URL segment (`/api/schema/contacts`).
 * Field `name` is the public camelCase key the API already reads and writes;
 * `mapsTo` documents the persistence column when the two differ.
 */
export const RESOURCE_DEFINITIONS = {
  contacts: {
    label: 'Contacts',
    fields: [
      SYSTEM_FIELDS.id,
      {
        name: 'firstName',
        label: 'First Name',
        type: 'string',
        required: false,
        readOnly: false,
        placeholder: 'Ada',
        mapsTo: 'first_name',
      },
      {
        name: 'lastName',
        label: 'Last Name',
        type: 'string',
        required: false,
        readOnly: false,
        placeholder: 'Lovelace',
        mapsTo: 'last_name',
      },
      {
        name: 'name',
        label: 'Full Name',
        type: 'string',
        required: false,
        readOnly: false,
        description: 'Convenience field split into first and last name.',
      },
      {
        name: 'email',
        label: 'Email',
        type: 'email',
        required: false,
        readOnly: false,
        placeholder: 'name@example.com',
      },
      {
        name: 'phone',
        label: 'Phone',
        type: 'string',
        required: false,
        readOnly: false,
        placeholder: '+1 555 000 0000',
      },
      {
        name: 'title',
        label: 'Job Title',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'companyId',
        label: 'Company',
        type: 'relation',
        required: false,
        readOnly: false,
        relation: 'companies',
        mapsTo: 'company_id',
      },
      {
        name: 'ownerId',
        label: 'Owner',
        type: 'string',
        required: false,
        readOnly: false,
        mapsTo: 'owner_id',
      },
      SYSTEM_FIELDS.createdAt,
      SYSTEM_FIELDS.updatedAt,
    ],
  },
  leads: {
    label: 'Leads',
    fields: [
      SYSTEM_FIELDS.id,
      {
        name: 'firstName',
        label: 'First Name',
        type: 'string',
        required: false,
        readOnly: false,
        mapsTo: 'first_name',
      },
      {
        name: 'lastName',
        label: 'Last Name',
        type: 'string',
        required: false,
        readOnly: false,
        mapsTo: 'last_name',
      },
      {
        name: 'name',
        label: 'Full Name',
        type: 'string',
        required: false,
        readOnly: false,
        description: 'Convenience field split into first and last name.',
      },
      {
        name: 'email',
        label: 'Email',
        type: 'email',
        required: false,
        readOnly: false,
        placeholder: 'name@example.com',
      },
      {
        name: 'phone',
        label: 'Phone',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'companyName',
        label: 'Company',
        type: 'string',
        required: false,
        readOnly: false,
        mapsTo: 'company_name',
      },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: false,
        readOnly: false,
        defaultValue: 'New',
      },
      {
        name: 'source',
        label: 'Source',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'value',
        label: 'Estimated Value',
        type: 'number',
        required: false,
        readOnly: false,
        format: 'currency',
      },
      {
        name: 'ownerId',
        label: 'Owner',
        type: 'string',
        required: false,
        readOnly: false,
        mapsTo: 'owner_id',
      },
      SYSTEM_FIELDS.createdAt,
      SYSTEM_FIELDS.updatedAt,
    ],
  },
  companies: {
    label: 'Companies',
    fields: [
      SYSTEM_FIELDS.id,
      {
        name: 'name',
        label: 'Company Name',
        type: 'string',
        required: true,
        readOnly: false,
        placeholder: 'Acme Corporation',
      },
      {
        name: 'domain',
        label: 'Domain',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'industry',
        label: 'Industry',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'website',
        label: 'Website',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'country',
        label: 'Country',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'size',
        label: 'Size',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'employees',
        label: 'Employees',
        type: 'number',
        required: false,
        readOnly: false,
      },
      {
        name: 'owner',
        label: 'Owner',
        type: 'string',
        required: false,
        readOnly: false,
      },
      SYSTEM_FIELDS.createdAt,
      SYSTEM_FIELDS.updatedAt,
    ],
  },
  deals: {
    label: 'Deals',
    fields: [
      SYSTEM_FIELDS.id,
      {
        name: 'title',
        label: 'Deal Name',
        type: 'string',
        required: true,
        readOnly: false,
      },
      {
        name: 'company',
        label: 'Company',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'companyId',
        label: 'Company ID',
        type: 'relation',
        required: false,
        readOnly: false,
        relation: 'companies',
        mapsTo: 'company_id',
      },
      {
        name: 'contact',
        label: 'Contact',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'contactId',
        label: 'Contact ID',
        type: 'relation',
        required: false,
        readOnly: false,
        relation: 'contacts',
        mapsTo: 'contact_id',
      },
      {
        name: 'pipelineId',
        label: 'Pipeline',
        type: 'select',
        required: false,
        readOnly: false,
        mapsTo: 'pipeline_id',
      },
      {
        name: 'owner',
        label: 'Owner',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'ownerId',
        label: 'Owner ID',
        type: 'string',
        required: false,
        readOnly: false,
        mapsTo: 'owner_id',
      },
      {
        name: 'value',
        label: 'Value',
        type: 'number',
        required: false,
        readOnly: false,
        format: 'currency',
      },
      {
        name: 'stage',
        label: 'Stage',
        type: 'select',
        required: false,
        readOnly: false,
      },
      {
        name: 'closeDate',
        label: 'Expected Close Date',
        type: 'date',
        required: false,
        readOnly: false,
        mapsTo: 'expected_close_date',
      },
      SYSTEM_FIELDS.createdAt,
      SYSTEM_FIELDS.updatedAt,
    ],
  },
  tickets: {
    label: 'Tickets',
    fields: [
      SYSTEM_FIELDS.id,
      {
        name: 'subject',
        label: 'Subject',
        type: 'string',
        required: true,
        readOnly: false,
        placeholder: 'Cannot log in',
      },
      {
        name: 'description',
        label: 'Description',
        type: 'text',
        required: false,
        readOnly: false,
      },
      {
        name: 'stage',
        label: 'Stage',
        type: 'select',
        required: false,
        readOnly: false,
        defaultValue: 'New',
      },
      {
        name: 'priority',
        label: 'Priority',
        type: 'select',
        required: false,
        readOnly: false,
        defaultValue: 'Normal',
      },
      {
        name: 'source',
        label: 'Source',
        type: 'select',
        required: false,
        readOnly: false,
        defaultValue: 'Email',
      },
      {
        name: 'contact',
        label: 'Contact',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'contactEmail',
        label: 'Contact Email',
        type: 'email',
        required: false,
        readOnly: false,
        mapsTo: 'contact_email',
      },
      {
        name: 'comments',
        label: 'Comments',
        type: 'json',
        required: false,
        readOnly: true,
      },
      {
        name: 'firstResponseAt',
        label: 'First Response At',
        type: 'datetime',
        required: false,
        readOnly: true,
        mapsTo: 'first_response_at',
      },
      {
        name: 'firstResponseDueAt',
        label: 'First Response Due At',
        type: 'datetime',
        required: false,
        readOnly: true,
        mapsTo: 'first_response_due_at',
      },
      {
        name: 'resolvedAt',
        label: 'Resolved At',
        type: 'datetime',
        required: false,
        readOnly: true,
        mapsTo: 'resolved_at',
      },
      {
        name: 'resolvedBy',
        label: 'Resolved By',
        type: 'string',
        required: false,
        readOnly: true,
        mapsTo: 'resolved_by',
      },
      {
        name: 'slaDueAt',
        label: 'SLA Due At',
        type: 'datetime',
        required: false,
        readOnly: true,
        mapsTo: 'sla_due_at',
      },
      {
        name: 'slaBreached',
        label: 'SLA Breached',
        type: 'boolean',
        required: false,
        readOnly: true,
        mapsTo: 'sla_breached',
      },
      {
        name: 'closedAt',
        label: 'Closed At',
        type: 'datetime',
        required: false,
        readOnly: true,
        mapsTo: 'closed_at',
      },
      {
        name: 'stageHistory',
        label: 'Stage History',
        type: 'json',
        required: false,
        readOnly: true,
        mapsTo: 'stage_history',
      },
      SYSTEM_FIELDS.createdAt,
      SYSTEM_FIELDS.updatedAt,
    ],
  },
  quotes: {
    label: 'Quotes',
    fields: [
      SYSTEM_FIELDS.id,
      {
        name: 'title',
        label: 'Quote Name',
        type: 'string',
        required: true,
        readOnly: false,
      },
      {
        name: 'quoteNumber',
        label: 'Quote Number',
        type: 'string',
        required: false,
        readOnly: false,
        mapsTo: 'quote_number',
      },
      {
        name: 'dealId',
        label: 'Deal',
        type: 'relation',
        required: false,
        readOnly: false,
        relation: 'deals',
        mapsTo: 'deal_id',
      },
      {
        name: 'companyId',
        label: 'Company',
        type: 'relation',
        required: false,
        readOnly: false,
        relation: 'companies',
        mapsTo: 'company_id',
      },
      {
        name: 'contactId',
        label: 'Contact',
        type: 'relation',
        required: false,
        readOnly: false,
        relation: 'contacts',
        mapsTo: 'contact_id',
      },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: false,
        readOnly: false,
        defaultValue: 'Draft',
      },
      {
        name: 'subtotal',
        label: 'Subtotal',
        type: 'number',
        required: false,
        readOnly: false,
        format: 'currency',
      },
      {
        name: 'discount',
        label: 'Discount',
        type: 'number',
        required: false,
        readOnly: false,
      },
      {
        name: 'tax',
        label: 'Tax',
        type: 'number',
        required: false,
        readOnly: false,
      },
      {
        name: 'total',
        label: 'Total',
        type: 'number',
        required: false,
        readOnly: false,
        format: 'currency',
      },
      {
        name: 'expirationDate',
        label: 'Expiration Date',
        type: 'date',
        required: false,
        readOnly: false,
        mapsTo: 'expiration_date',
      },
      {
        name: 'items',
        label: 'Line Items',
        type: 'json',
        required: false,
        readOnly: false,
      },
      {
        name: 'notes',
        label: 'Notes',
        type: 'text',
        required: false,
        readOnly: false,
      },
      SYSTEM_FIELDS.createdAt,
      SYSTEM_FIELDS.updatedAt,
    ],
  },
  tasks: {
    label: 'Tasks',
    fields: [
      SYSTEM_FIELDS.id,
      {
        name: 'title',
        label: 'Title',
        type: 'string',
        required: true,
        readOnly: false,
        placeholder: 'Follow up on proposal',
      },
      {
        name: 'description',
        label: 'Description',
        type: 'text',
        required: false,
        readOnly: false,
      },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: false,
        readOnly: false,
        defaultValue: 'Open',
      },
      {
        name: 'completed',
        label: 'Completed',
        type: 'boolean',
        required: false,
        readOnly: false,
        defaultValue: false,
      },
      {
        name: 'priority',
        label: 'Priority',
        type: 'select',
        required: false,
        readOnly: false,
      },
      {
        name: 'owner',
        label: 'Owner',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'assignedTo',
        label: 'Assigned To',
        type: 'string',
        required: false,
        readOnly: false,
        mapsTo: 'assigned_to',
      },
      {
        name: 'dueDate',
        label: 'Due Date',
        type: 'date',
        required: false,
        readOnly: false,
        mapsTo: 'due_date',
      },
      {
        name: 'source',
        label: 'Source',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'contactId',
        label: 'Contact',
        type: 'relation',
        required: false,
        readOnly: false,
        relation: 'contacts',
        mapsTo: 'contact_id',
      },
      {
        name: 'dealId',
        label: 'Deal',
        type: 'relation',
        required: false,
        readOnly: false,
        relation: 'deals',
        mapsTo: 'deal_id',
      },
      SYSTEM_FIELDS.createdAt,
      SYSTEM_FIELDS.updatedAt,
    ],
  },
  activities: {
    label: 'Activities',
    fields: [
      SYSTEM_FIELDS.id,
      {
        name: 'type',
        label: 'Type',
        type: 'select',
        required: false,
        readOnly: false,
        defaultValue: 'Note',
      },
      {
        name: 'title',
        label: 'Title',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'subject',
        label: 'Subject',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'notes',
        label: 'Notes',
        type: 'text',
        required: false,
        readOnly: false,
        mapsTo: 'description',
      },
      {
        name: 'contact',
        label: 'Contact',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'company',
        label: 'Company',
        type: 'string',
        required: false,
        readOnly: false,
      },
      {
        name: 'direction',
        label: 'Direction',
        type: 'select',
        required: false,
        readOnly: false,
      },
      {
        name: 'recordId',
        label: 'Record',
        type: 'string',
        required: false,
        readOnly: false,
        mapsTo: 'record_id',
      },
      {
        name: 'entityType',
        label: 'Entity Type',
        type: 'string',
        required: false,
        readOnly: false,
        mapsTo: 'entity_type',
      },
      {
        name: 'entityId',
        label: 'Entity ID',
        type: 'string',
        required: false,
        readOnly: false,
        mapsTo: 'entity_id',
      },
      {
        name: 'contactId',
        label: 'Contact ID',
        type: 'relation',
        required: false,
        readOnly: false,
        relation: 'contacts',
        mapsTo: 'contact_id',
      },
      {
        name: 'dealId',
        label: 'Deal ID',
        type: 'relation',
        required: false,
        readOnly: false,
        relation: 'deals',
        mapsTo: 'deal_id',
      },
      {
        name: 'userId',
        label: 'User',
        type: 'string',
        required: false,
        readOnly: false,
        mapsTo: 'user_id',
      },
      {
        name: 'metadata',
        label: 'Metadata',
        type: 'json',
        required: false,
        readOnly: true,
      },
      SYSTEM_FIELDS.createdAt,
      SYSTEM_FIELDS.updatedAt,
    ],
  },
};

/** Lower-case the URL segment and reject anything outside the registry. */
export function normalizeResource(resource) {
  if (typeof resource !== 'string') return null;
  const name = resource.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(RESOURCE_DEFINITIONS, name)
    ? name
    : null;
}

/** Every resource the reflection endpoint can describe, in registration order. */
export function listResources() {
  return Object.keys(RESOURCE_DEFINITIONS);
}

/** True when `resource` has a reflection definition. */
export function isSchemaResource(resource) {
  return normalizeResource(resource) !== null;
}

/**
 * Deal stage vocabulary. Pipeline definitions are the source of truth once a
 * workspace defines one; before that we fall back to the built-in default so the
 * board is never stage-less.
 */
function dealStageOptions(db) {
  const seen = new Map();
  for (const pipeline of Array.isArray(db.pipelineDefinitions)
    ? db.pipelineDefinitions
    : []) {
    for (const stage of Array.isArray(pipeline.stages) ? pipeline.stages : []) {
      const value = stage.key || stage.label;
      if (value && !seen.has(value)) seen.set(value, stage.label || value);
    }
  }
  if (seen.size === 0) {
    for (const stage of DEFAULT_PIPELINE) {
      if (stage.name && !seen.has(stage.name)) seen.set(stage.name, stage.name);
    }
  }
  return [...seen.entries()].map(([value, label]) => ({ label, value }));
}

/** Pipeline definitions as `{ id, name }` options for the deal pipeline picker. */
function pipelineOptions(db) {
  return (Array.isArray(db.pipelineDefinitions) ? db.pipelineDefinitions : [])
    .filter((pipeline) => pipeline && pipeline.id)
    .map((pipeline) => ({
      label: pipeline.name || pipeline.id,
      value: pipeline.id,
    }));
}

/**
 * Enumerations the registry marks as `select` but whose vocabulary is owned by
 * an imported module or a shared constant.
 */
function resolveOptions(resource, fieldName, dynamic) {
  switch (`${resource}.${fieldName}`) {
    case 'tickets.stage':
      return dynamic.ticketStages;
    case 'tickets.priority':
      return dynamic.ticketPriorities;
    case 'tickets.source':
      return dynamic.ticketSources;
    case 'deals.stage':
      return dynamic.dealStages;
    case 'deals.pipelineId':
      return dynamic.pipelines;
    case 'leads.status':
      return dynamic.leadStatuses;
    case 'tasks.status':
      return dynamic.taskStatuses;
    case 'tasks.priority':
      return dynamic.taskPriorities;
    case 'activities.type':
      return dynamic.activityTypes;
    case 'activities.direction':
      return dynamic.activityDirections;
    case 'quotes.status':
      return dynamic.quoteStatuses;
    default:
      return null;
  }
}

/** Copy a registry entry into the wire contract, resolving dynamic options. */
function enrichField(resource, field, dynamic) {
  const resolved = {
    ...field,
    key: field.name,
    required: Boolean(field.required),
    readOnly: Boolean(field.readOnly),
  };
  const resolvedOptions = resolveOptions(resource, field.name, dynamic);
  if (resolvedOptions) resolved.options = resolvedOptions;
  return resolved;
}

/** Normalise a custom field spec into the same metadata contract. */
function customFieldSchema(spec) {
  const field = {
    name: spec.key,
    key: spec.key,
    label: spec.label,
    type: spec.type,
    required: Boolean(spec.required),
    readOnly: false,
    custom: true,
  };
  if (Array.isArray(spec.options)) field.options = options(spec.options);
  return field;
}

/**
 * Build the reflection payload for one resource. Returns `null` for an unknown
 * resource so the HTTP layer can answer 404 without throwing.
 */
export function buildResourceSchema(resource, { db = {}, settings } = {}) {
  const name = normalizeResource(resource);
  if (!name) return null;

  const definition = RESOURCE_DEFINITIONS[name];
  const workspace = settings || db.settings || {};

  const dynamic = {
    ticketStages: options(RECOGNIZED_STAGES),
    ticketPriorities: slaPriorityOptions(),
    ticketSources: options(TICKET_SOURCES),
    dealStages: dealStageOptions(db),
    pipelines: pipelineOptions(db),
    leadStatuses: options(LEAD_STATUSES),
    taskStatuses: options(TASK_STATUSES),
    taskPriorities: options(TASK_PRIORITIES),
    activityTypes: options(ACTIVITY_TYPES),
    activityDirections: options(ACTIVITY_DIRECTIONS),
    quoteStatuses: options(QUOTE_STATUSES),
  };

  const legacyCustomFields = customFieldSpecs(db, name);
  const fields = [
    ...definition.fields.map((field) => enrichField(name, field, dynamic)),
    ...legacyCustomFields.map(customFieldSchema),
  ];

  return {
    object: name,
    resource: name,
    label: definition.label,
    primaryKey: 'id',
    currency: workspace.currency || 'USD',
    fields,
    // Backwards-compatible projection for the existing `/schema/:object`
    // consumer, which only wants the augmenting custom fields.
    customFields: legacyCustomFields,
  };
}

/** URL segments this router answers, for error messages and docs. */
export function listSchemaResources() {
  return Object.keys(RESOURCE_DEFINITIONS);
}
