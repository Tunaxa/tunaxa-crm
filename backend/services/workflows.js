import crypto from 'node:crypto';
import { readDb, mutateDb } from '../store.js';
import { DEFAULT_SETTINGS } from './config.js';
import { runAction, deliverMessages } from './actions.js';
import { matchCondition, matchConditions } from './conditions.js';
import { scheduleExecution } from './queue.js';
import { repoFor } from '../db/repositories/index.js';
import { parseDelayToMs } from './duration.js';
import { scheduleWorkflowWaitJob } from './workflowQueue.js';

export { parseDelayToMs };

const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const now = () => new Date().toISOString();

const RESOURCE_BY_EVENT_PREFIX = {
  lead: 'leads',
  contact: 'contacts',
  company: 'companies',
  deal: 'deals',
  quote: 'quotes',
  contract: 'contracts',
  task: 'tasks',
  call: 'calls',
  message: 'messages',
  product: 'products',
  order: 'orders',
  invoice: 'invoices',
  expense: 'expenses',
  campaign: 'campaigns',
  emailList: 'emailLists',
  landingPage: 'landingPages',
  employee: 'employees',
  leaveRequest: 'leaveRequests',
  attendance: 'attendance',
  form: 'leads',
  webhook: 'webhookEndpoints'
};

export const EVENT_META = [
  { value: 'lead.created', label: 'Lead created', resource: 'leads' },
  { value: 'lead.updated', label: 'Lead updated', resource: 'leads' },
  { value: 'lead.scored', label: 'Lead Scored', resource: 'leads', description: 'Triggered when lead scoring completes and score meets or exceeds threshold' },
  { value: 'contact.created', label: 'Contact created', resource: 'contacts' },
  { value: 'contact.updated', label: 'Contact updated', resource: 'contacts' },
  { value: 'company.created', label: 'Company created', resource: 'companies' },
  { value: 'company.updated', label: 'Company updated', resource: 'companies' },
  { value: 'deal.created', label: 'Deal created', resource: 'deals' },
  { value: 'deal.updated', label: 'Deal updated', resource: 'deals' },
  { value: 'deal.won', label: 'Deal won', resource: 'deals' },
  { value: 'task.created', label: 'Task created', resource: 'tasks' },
  { value: 'task.updated', label: 'Task updated', resource: 'tasks' },
  { value: 'task.completed', label: 'Task completed', resource: 'tasks' },
  { value: 'call.completed', label: 'Call completed', resource: 'calls' },
  { value: 'message.sent', label: 'Message sent', resource: 'messages' },
  { value: 'form.submitted', label: 'Form submitted', resource: 'leads' },
  { value: 'product.created', label: 'Product created', resource: 'products' },
  { value: 'product.updated', label: 'Product updated', resource: 'products' },
  { value: 'order.created', label: 'Order created', resource: 'orders' },
  { value: 'order.updated', label: 'Order updated', resource: 'orders' },
  { value: 'invoice.created', label: 'Invoice created', resource: 'invoices' },
  { value: 'invoice.updated', label: 'Invoice updated', resource: 'invoices' },
  { value: 'expense.created', label: 'Expense created', resource: 'expenses' },
  { value: 'expense.updated', label: 'Expense updated', resource: 'expenses' },
  { value: 'campaign.created', label: 'Campaign created', resource: 'campaigns' },
  { value: 'campaign.updated', label: 'Campaign updated', resource: 'campaigns' },
  { value: 'emailList.created', label: 'Email list created', resource: 'emailLists' },
  { value: 'emailList.updated', label: 'Email list updated', resource: 'emailLists' },
  { value: 'landingPage.created', label: 'Landing page created', resource: 'landingPages' },
  { value: 'landingPage.updated', label: 'Landing page updated', resource: 'landingPages' },
  { value: 'employee.created', label: 'Employee created', resource: 'employees' },
  { value: 'employee.updated', label: 'Employee updated', resource: 'employees' },
  { value: 'leaveRequest.created', label: 'Leave request created', resource: 'leaveRequests' },
  { value: 'leaveRequest.updated', label: 'Leave request updated', resource: 'leaveRequests' },
  { value: 'attendance.created', label: 'Attendance created', resource: 'attendance' },
  { value: 'attendance.updated', label: 'Attendance updated', resource: 'attendance' },
  { value: 'webhook.received', label: 'Webhook received', resource: 'webhookEndpoints' },
  { value: 'quote.created', label: 'Quote created', resource: 'quotes' },
  { value: 'quote.updated', label: 'Quote updated', resource: 'quotes' },
  { value: 'quote.signed', label: 'Quote signed', resource: 'quotes' },
  { value: 'contract.created', label: 'Contract created', resource: 'contracts' },
  { value: 'contract.updated', label: 'Contract updated', resource: 'contracts' }
];

export const ACTION_META = [
  { type: 'email', label: 'Send email', fields: ['to', 'subject', 'body'] },
  { type: 'sms', label: 'Send SMS', fields: ['to', 'body'] },
  { type: 'task', label: 'Create task', fields: ['title', 'owner', 'priority', 'dueDate'] },
  { type: 'activity', label: 'Log activity', fields: ['title', 'subtype', 'notes'] },
  { type: 'update', label: 'Update the record', fields: ['field', 'value'] }
];

export const NODE_META = {
  start: { label: 'Trigger' },
  trigger: { label: 'Trigger' },
  condition: { label: 'If / Else branch' },
  delay: { label: 'Wait & schedule' },
  wait: { label: 'Wait' },
  action: { label: 'Action' }
};

function matchesFilter(flow, record) {
  return matchCondition(record, flow.filter || {});
}

export function eventFor(resource, previous, next) {
  if (resource === 'deals' && previous && next) {
    return (previous.stage || 'new') !== 'won' && next.stage === 'won' ? 'deal.won' : 'deal.updated';
  }
  if (resource === 'tasks' && previous && next) {
    return previous.status !== 'Completed' && next.status === 'Completed' ? 'task.completed' : 'task.updated';
  }
  return null;
}

export const createdEvent = resource => ({
  leads: 'lead.created', contacts: 'contact.created', companies: 'company.created', deals: 'deal.created', tasks: 'task.created',
  products: 'product.created', orders: 'order.created', invoices: 'invoice.created', expenses: 'expense.created',
  campaigns: 'campaign.created', emailLists: 'emailList.created', landingPages: 'landingPage.created',
  employees: 'employee.created', leaveRequests: 'leaveRequest.created', attendance: 'attendance.created',
  quotes: 'quote.created', contracts: 'contract.created'
}[resource] || null);

export const updatedEvent = resource => ({
  leads: 'lead.updated', contacts: 'contact.updated', companies: 'company.updated', deals: 'deal.updated', tasks: 'task.updated',
  products: 'product.updated', orders: 'order.updated', invoices: 'invoice.updated', expenses: 'expense.updated',
  campaigns: 'campaign.updated', emailLists: 'emailList.updated', landingPages: 'landingPage.updated',
  employees: 'employee.updated', leaveRequests: 'leaveRequest.updated', attendance: 'attendance.updated',
  quotes: 'quote.updated', contracts: 'contract.updated'
}[resource] || null);

/**
 * Resolves a field from a record, supporting dot-notation nested properties
 * and custom_fields fallbacks.
 */
export function getFieldValue(record, fieldPath) {
  if (!record || !fieldPath) return undefined;
  if (typeof record !== 'object') return undefined;

  // Direct top-level property
  if (Object.prototype.hasOwnProperty.call(record, fieldPath)) {
    return record[fieldPath];
  }

  // Nested property path, e.g. "company.name"
  const parts = String(fieldPath).split('.');
  let current = record;
  let found = true;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      found = false;
      break;
    }
  }
  if (found && current !== undefined) {
    return current;
  }

  // Fallback to custom_fields / customFields
  const customFields = record.custom_fields || record.customFields;
  if (customFields && typeof customFields === 'object') {
    if (Object.prototype.hasOwnProperty.call(customFields, fieldPath)) {
      return customFields[fieldPath];
    }
    let cfCurrent = customFields;
    let cfFound = true;
    for (const part of parts) {
      if (cfCurrent && typeof cfCurrent === 'object' && part in cfCurrent) {
        cfCurrent = cfCurrent[part];
      } else {
        cfFound = false;
        break;
      }
    }
    if (cfFound && cfCurrent !== undefined) {
      return cfCurrent;
    }
  }

  return undefined;
}

/**
 * Evaluates an operator predicate with case-insensitive string comparisons
 * and numeric conversions.
 */
export function evaluateOperator(op, actual, expected) {
  const operator = String(op || 'equals').trim().toLowerCase();

  switch (operator) {
    case 'equals':
    case 'eq':
    case '==':
    case '===': {
      if (actual === undefined || actual === null) {
        return expected === undefined || expected === null || expected === '';
      }
      if (expected === undefined || expected === null) {
        return actual === '';
      }
      const actStr = String(actual).trim();
      const expStr = String(expected).trim();
      if (actStr !== '' && expStr !== '' && !Number.isNaN(Number(actStr)) && !Number.isNaN(Number(expStr))) {
        if (Number(actStr) === Number(expStr)) return true;
      }
      return actStr.toLowerCase() === expStr.toLowerCase();
    }

    case 'not_equals':
    case 'not_equal':
    case 'neq':
    case '!=':
    case '!==': {
      return !evaluateOperator('equals', actual, expected);
    }

    case 'contains': {
      if (actual === undefined || actual === null) return false;
      const actStr = String(actual).toLowerCase();
      const expStr = String(expected ?? '').toLowerCase();
      return actStr.includes(expStr);
    }

    case 'not_contains':
    case 'notcontains': {
      return !evaluateOperator('contains', actual, expected);
    }

    case 'greater_than':
    case 'gt':
    case '>': {
      const actNum = Number(actual);
      const expNum = Number(expected);
      if (Number.isNaN(actNum) || Number.isNaN(expNum)) return false;
      return actNum > expNum;
    }

    case 'greater_than_or_equal':
    case 'gte':
    case '>=': {
      const actNum = Number(actual);
      const expNum = Number(expected);
      if (Number.isNaN(actNum) || Number.isNaN(expNum)) return false;
      return actNum >= expNum;
    }

    case 'less_than':
    case 'lt':
    case '<': {
      const actNum = Number(actual);
      const expNum = Number(expected);
      if (Number.isNaN(actNum) || Number.isNaN(expNum)) return false;
      return actNum < expNum;
    }

    case 'less_than_or_equal':
    case 'lte':
    case '<=': {
      const actNum = Number(actual);
      const expNum = Number(expected);
      if (Number.isNaN(actNum) || Number.isNaN(expNum)) return false;
      return actNum <= expNum;
    }

    case 'is_empty':
    case 'empty': {
      if (actual === undefined || actual === null) return true;
      if (typeof actual === 'string') return actual.trim() === '';
      if (Array.isArray(actual)) return actual.length === 0;
      if (typeof actual === 'object') return Object.keys(actual).length === 0;
      return false;
    }

    case 'is_not_empty':
    case 'not_empty':
    case 'isset': {
      return !evaluateOperator('is_empty', actual, expected);
    }

    case 'isnotset': {
      return actual === undefined || actual === null || actual === '';
    }

    case 'in': {
      if (actual === undefined || actual === null) return false;
      const actStr = String(actual).trim().toLowerCase();
      let list = [];
      if (Array.isArray(expected)) {
        list = expected.map(x => String(x ?? '').trim().toLowerCase());
      } else if (typeof expected === 'string') {
        list = expected.split(',').map(x => x.trim().toLowerCase());
      } else {
        list = [String(expected ?? '').trim().toLowerCase()];
      }
      return list.includes(actStr);
    }

    case 'not_in':
    case 'notin': {
      return !evaluateOperator('in', actual, expected);
    }

    case 'starts_with':
    case 'startswith': {
      if (actual === undefined || actual === null) return false;
      return String(actual).toLowerCase().startsWith(String(expected ?? '').toLowerCase());
    }

    case 'ends_with':
    case 'endswith': {
      if (actual === undefined || actual === null) return false;
      return String(actual).toLowerCase().endsWith(String(expected ?? '').toLowerCase());
    }

    case 'daysago': {
      if (!actual) return false;
      const days = Number(expected);
      if (Number.isNaN(days)) return false;
      const timestamp = new Date(actual).getTime();
      if (Number.isNaN(timestamp)) return false;
      const ageDays = (Date.now() - timestamp) / 86400000;
      return ageDays >= days;
    }

    default:
      return true;
  }
}

/**
 * Evaluates a condition or compound rule against a record and execution context.
 */
export function evaluateCondition(condition, record, context = {}) {
  if (!condition) return true;

  const cond = condition.config || condition.data || condition;

  // Compound rules support
  const rules = cond.rules || cond.conditions;
  if (Array.isArray(rules) && rules.length > 0) {
    const matchType = String(cond.match || cond.logic || 'all').toLowerCase();
    const results = rules.map(rule => evaluateCondition(rule, record, context));
    return matchType === 'any' ? results.some(Boolean) : results.every(Boolean);
  }

  // Single rule
  const field = cond.field;
  if (!field) return true;

  const actual = getFieldValue(record, field) ?? (context && getFieldValue(context, field));
  const operator = cond.operator || cond.op || 'equals';
  const expected = cond.value;

  return evaluateOperator(operator, actual, expected);
}

function normalizeActionType(type) {
  const t = String(type || '').trim().toLowerCase();
  const map = {
    send_email: 'email',
    sendemail: 'email',
    email: 'email',
    create_task: 'task',
    createtask: 'task',
    task: 'task',
    update_record: 'update',
    updaterecord: 'update',
    update: 'update',
    log_activity: 'activity',
    logactivity: 'activity',
    activity: 'activity',
    send_sms: 'sms',
    sendsms: 'sms',
    sms: 'sms'
  };
  return map[t] || type;
}

function getOutgoingEdges(workflow) {
  const edges = Array.isArray(workflow.edges)
    ? workflow.edges
    : Array.isArray(workflow.connections)
    ? workflow.connections
    : [];

  const outgoing = new Map();
  if (Array.isArray(workflow.nodes)) {
    for (const node of workflow.nodes) {
      outgoing.set(node.id, []);
    }
  }

  for (const edge of edges) {
    const source = edge.source || edge.from || edge.sourceNodeId;
    const target = edge.target || edge.to || edge.targetNodeId;
    const sourceHandle = edge.sourceHandle ?? edge.fromHandle ?? edge.handle ?? null;
    if (source && target) {
      if (!outgoing.has(source)) outgoing.set(source, []);
      outgoing.get(source).push({ target, sourceHandle });
    }
  }

  // Backward compatibility: link pointers on nodes (.next, .trueNext, .falseNext)
  if (Array.isArray(workflow.nodes)) {
    for (const node of workflow.nodes) {
      const list = outgoing.get(node.id);
      if (list && list.length === 0) {
        if (node.next) {
          list.push({ target: node.next, sourceHandle: null });
        }
        if (node.trueNext) {
          list.push({ target: node.trueNext, sourceHandle: 'true' });
        }
        if (node.falseNext) {
          list.push({ target: node.falseNext, sourceHandle: 'false' });
        }
      }
    }
  }

  return outgoing;
}

function isTrueHandle(handle) {
  if (!handle) return true;
  const h = String(handle).trim().toLowerCase();
  return h === 'true' || h === 'yes' || h === 'pass' || h === 'success' || h === '1';
}

function isFalseHandle(handle) {
  if (!handle) return false;
  const h = String(handle).trim().toLowerCase();
  return h === 'false' || h === 'no' || h === 'fail' || h === '0';
}

function getConditionEdges(edgesFromNode, passes) {
  if (passes) {
    const explicitTrue = edgesFromNode.filter(e => {
      const h = String(e.sourceHandle ?? '').trim().toLowerCase();
      return h === 'true' || h === 'yes' || h === 'pass' || h === 'success' || h === '1';
    });
    if (explicitTrue.length > 0) return explicitTrue;

    return edgesFromNode.filter(e => !isFalseHandle(e.sourceHandle));
  } else {
    return edgesFromNode.filter(e => isFalseHandle(e.sourceHandle));
  }
}

async function createRunRecord({ workflow, event, context = {} }) {
  try {
    const repo = repoFor('workflowRuns');
    if (!repo || typeof repo.create !== 'function') return null;
    return await repo.create({
      workflow_id: workflow.id,
      trigger_event: event || workflow.event || 'unknown',
      status: 'running',
      started_at: new Date().toISOString(),
      steps: [],
      workspace_id: workflow.workspace_id || workflow.workspaceId || context.workspaceId || context.workspace_id || 'default'
    });
  } catch (err) {
    return null;
  }
}

async function updateRunRecord(runId, { status, steps, error_message }) {
  if (!runId) return null;
  try {
    const repo = repoFor('workflowRuns');
    if (!repo || typeof repo.update !== 'function') return null;
    const updatePayload = {
      status,
      steps: Array.isArray(steps) ? steps : [],
      error_message: error_message || null
    };
    if (status !== 'waiting') {
      updatePayload.completed_at = new Date().toISOString();
    }
    return await repo.update(runId, updatePayload);
  } catch (err) {
    return null;
  }
}

/**
 * Traverses and executes a visual node graph (Trigger -> Condition -> Action/Delay)
 * in topological/breadth-first order with branch skipping and cycle protection.
 */
export async function executeNodeGraph(workflow, event, record, context = {}) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  if (!nodes.length) {
    return { executedNodes: [], executedActions: [], outbound: [], steps: [] };
  }

  let runId = context.runId;
  if (!runId) {
    const run = await createRunRecord({ workflow, event, context });
    if (run) runId = run.id;
  }

  const outgoing = getOutgoingEdges(workflow);
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Locate start nodes (from context.startNodeIds if resuming, else trigger/start nodes)
  let queue;
  if (context.startNodeIds) {
    const startIds = Array.isArray(context.startNodeIds)
      ? context.startNodeIds
      : [context.startNodeIds].filter(Boolean);
    queue = [...startIds];
  } else {
    let triggerNodes = nodes.filter(n => {
      const t = String(n.type || '').trim().toLowerCase();
      return t === 'trigger' || t === 'start';
    });
    if (event && triggerNodes.length > 1) {
      const matching = triggerNodes.filter(n => {
        const nodeEvent = n.config?.event || n.data?.event || n.event;
        return !nodeEvent || nodeEvent === event;
      });
      if (matching.length) triggerNodes = matching;
    }

    if (!triggerNodes.length) {
      const targetIds = new Set();
      for (const list of outgoing.values()) {
        for (const edge of list) targetIds.add(edge.target);
      }
      const rootNodes = nodes.filter(n => !targetIds.has(n.id));
      triggerNodes = rootNodes.length ? rootNodes : [nodes[0]];
    }

    queue = [...triggerNodes.map(n => n.id)];
  }

  const resource = context.resource ||
    RESOURCE_BY_EVENT_PREFIX[String(event || workflow.event || '').split('.')[0]] ||
    '';

  const visited = new Set();
  const executedNodes = [];
  const executedActions = [];
  const outbound = [];
  let stepsLog = [];

  if (context.isResume && runId) {
    const repo = repoFor('workflowRuns');
    if (repo && typeof repo.findById === 'function') {
      try {
        const existingRun = await repo.findById(runId);
        if (existingRun && existingRun.steps) {
          stepsLog = Array.isArray(existingRun.steps)
            ? [...existingRun.steps]
            : (typeof existingRun.steps === 'string' ? JSON.parse(existingRun.steps) : []);
        }
      } catch (_) {}
    }
  }

  let hasErrors = false;
  let isWaiting = false;
  let finalErrorMessage = null;
  let steps = 0;
  const MAX_STEPS = 200;

  try {
    await mutateDb(async db => {
      while (queue.length > 0 && steps++ < MAX_STEPS) {
        const nodeId = queue.shift();
        if (!nodeId || visited.has(nodeId)) continue;
        visited.add(nodeId);

        const node = nodeMap.get(nodeId);
        if (!node) continue;
        executedNodes.push(nodeId);

        const nodeType = String(node.type || '').trim().toLowerCase();

        if (nodeType === 'trigger' || nodeType === 'start') {
          stepsLog.push({
            nodeId: node.id,
            nodeType: node.type || 'trigger',
            nodeName: node.data?.label || node.config?.name || 'Trigger',
            status: 'success',
            output: { event },
            error: null,
            executedAt: new Date().toISOString()
          });

          const edgesFromNode = outgoing.get(nodeId) || [];
          for (const edge of edgesFromNode) {
            if (!visited.has(edge.target)) queue.push(edge.target);
          }
          continue;
        }

        if (nodeType === 'condition') {
          let passes = false;
          let condError = null;
          try {
            const condConfig = node.config || node.data || node;
            passes = evaluateCondition(condConfig, record, context);
          } catch (err) {
            condError = err;
            hasErrors = true;
            if (!finalErrorMessage) finalErrorMessage = err.message;
          }

          stepsLog.push({
            nodeId: node.id,
            nodeType: 'condition',
            nodeName: node.data?.label || node.config?.name || 'Condition',
            status: condError ? 'failed' : 'success',
            output: { result: passes },
            error: condError?.message || null,
            executedAt: new Date().toISOString()
          });

          const edgesFromNode = outgoing.get(nodeId) || [];
          const edgesToFollow = getConditionEdges(edgesFromNode, passes);

          // Mark skipped branch nodes
          const skippedEdges = passes
            ? edgesFromNode.filter(e => isFalseHandle(e.sourceHandle))
            : edgesFromNode.filter(e => isTrueHandle(e.sourceHandle));
          for (const edge of skippedEdges) {
            const skippedNode = nodeMap.get(edge.target);
            if (skippedNode && !visited.has(skippedNode.id)) {
              stepsLog.push({
                nodeId: skippedNode.id,
                nodeType: skippedNode.type || 'action',
                nodeName: skippedNode.data?.label || skippedNode.config?.name || skippedNode.type,
                status: 'skipped',
                output: null,
                error: null,
                executedAt: new Date().toISOString()
              });
            }
          }

          for (const edge of edgesToFollow) {
            if (!visited.has(edge.target)) queue.push(edge.target);
          }
          continue;
        }

        if (nodeType === 'delay') {
          let delayError = null;
          try {
            const config = node.config || node.data || {};
            const minutes = Number(config.minutes ?? config.delayMinutes ?? (Number(config.hours ?? config.delayHours ?? 0) * 60)) || 0;
            if (config.action?.type) {
              const dueAt = new Date(Date.now() + minutes * 60000).toISOString();
              scheduleExecution(db, {
                flowId: workflow.id,
                flowName: workflow.name,
                resource,
                record,
                action: config.action,
                dueAt,
                context
              });
              db.audit.unshift({
                id: id('audit'),
                action: `Workflow "${workflow.name}" scheduled a delayed action`,
                actor: 'Workflow',
                createdAt: now()
              });
            }
          } catch (err) {
            delayError = err;
            hasErrors = true;
            if (!finalErrorMessage) finalErrorMessage = err.message;
          }

          stepsLog.push({
            nodeId: node.id,
            nodeType: 'delay',
            nodeName: node.data?.label || node.config?.name || 'Delay',
            status: delayError ? 'failed' : 'success',
            output: delayError ? null : { scheduled: true },
            error: delayError?.message || null,
            executedAt: new Date().toISOString()
          });

          const edgesFromNode = outgoing.get(nodeId) || [];
          for (const edge of edgesFromNode) {
            if (!visited.has(edge.target)) queue.push(edge.target);
          }
          continue;
        }

        if (nodeType === 'wait') {
          let waitError = null;
          const delayRaw = node.config?.delay ?? node.data?.delay ?? node.config?.duration ?? node.data?.duration;
          const delayStr = typeof delayRaw === 'object'
            ? (delayRaw.delay || delayRaw.duration || (delayRaw.amount && delayRaw.unit ? `${delayRaw.amount} ${delayRaw.unit}` : JSON.stringify(delayRaw)))
            : String(delayRaw ?? '');
          const delayMs = parseDelayToMs(delayRaw);
          const scheduledResumeAt = new Date(Date.now() + delayMs).toISOString();

          stepsLog.push({
            nodeId: node.id,
            nodeType: 'wait',
            nodeName: node.data?.label || node.config?.name || 'Wait',
            status: 'waiting',
            output: { delay: delayStr, delayMs, scheduledResumeAt },
            error: null,
            executedAt: new Date().toISOString()
          });

          const edgesFromNode = outgoing.get(nodeId) || [];
          const targetNodeIds = edgesFromNode.map(e => e.target).filter(Boolean);

          try {
            await scheduleWorkflowWaitJob({
              workflowId: workflow.id,
              runId,
              waitNodeId: node.id,
              targetNodeIds,
              delayMs,
              record,
              context,
              event,
              workspaceId: workflow.workspace_id || workflow.workspaceId || context.workspaceId || context.workspace_id || 'default'
            });
            isWaiting = true;
          } catch (err) {
            waitError = err;
            hasErrors = true;
            if (!finalErrorMessage) finalErrorMessage = err.message;
          }

          // Do NOT execute downstream nodes synchronously — halt traversal along this branch
          continue;
        }

        if (nodeType === 'action') {
          let actionError = null;
          let actionResult = null;
          try {
            const actionData = node.config || node.data || {};
            const actionType = actionData.type || node.action || (typeof actionData.action === 'string' ? actionData.action : actionData.action?.type);
            const normalizedType = normalizeActionType(actionType);

            const actionConfig = {
              ...actionData,
              ...(typeof actionData.action === 'object' ? actionData.action : {}),
              type: normalizedType
            };

            const delayMinutes = Number(actionConfig.delayMinutes ?? (Number(actionConfig.delayHours ?? 0) * 60)) || 0;
            if (delayMinutes > 0) {
              const dueAt = new Date(Date.now() + delayMinutes * 60000).toISOString();
              scheduleExecution(db, {
                flowId: workflow.id,
                flowName: workflow.name,
                resource,
                record,
                action: actionConfig,
                dueAt,
                context
              });
              db.audit.unshift({
                id: id('audit'),
                action: `Workflow "${workflow.name}" scheduled a delayed action`,
                actor: 'Workflow',
                createdAt: now()
              });
              actionResult = { scheduled: true, dueAt };
            } else {
              const messages = await runAction(db, actionConfig, record, {
                resource,
                flowId: workflow.id,
                flowName: workflow.name,
                ...context
              });
              if (Array.isArray(messages)) {
                outbound.push(...messages);
              }
              actionResult = { executed: true, messagesCount: Array.isArray(messages) ? messages.length : 0 };
            }
            executedActions.push(nodeId);
          } catch (err) {
            actionError = err;
            hasErrors = true;
            if (!finalErrorMessage) finalErrorMessage = err.message;
          }

          stepsLog.push({
            nodeId: node.id,
            nodeType: 'action',
            nodeName: node.data?.label || node.config?.name || node.config?.type || node.type,
            status: actionError ? 'failed' : 'success',
            output: actionResult,
            error: actionError?.message || null,
            executedAt: new Date().toISOString()
          });

          const edgesFromNode = outgoing.get(nodeId) || [];
          for (const edge of edgesFromNode) {
            if (!visited.has(edge.target)) queue.push(edge.target);
          }
          continue;
        }

        // Any other node type: follow outgoing edges
        const edgesFromNode = outgoing.get(nodeId) || [];
        for (const edge of edgesFromNode) {
          if (!visited.has(edge.target)) queue.push(edge.target);
        }
      }

      if (executedActions.length > 0) {
        db.audit.unshift({
          id: id('audit'),
          action: `Workflow "${workflow.name}" executed (${event || workflow.event || 'graph'})`,
          actor: 'Workflow',
          createdAt: now()
        });
      }
    });
  } catch (err) {
    hasErrors = true;
    if (!finalErrorMessage) finalErrorMessage = err.message;
  }

  const finalStatus = hasErrors ? 'failed' : (isWaiting ? 'waiting' : 'success');

  if (runId) {
    await updateRunRecord(runId, {
      status: finalStatus,
      steps: stepsLog,
      error_message: finalErrorMessage || null
    });
  }

  if (outbound.length > 0) {
    const db = await readDb();
    const settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
    await deliverMessages(outbound, settings);
  }

  return { executedNodes, executedActions, outbound, runId, steps: stepsLog, status: finalStatus };
}

/**
 * Resumes workflow node graph execution from a set of target nodes
 * (e.g. after a Wait node delay has elapsed).
 *
 * @param {object} params
 * @param {object} params.workflow - Workflow definition
 * @param {string} params.runId - Existing workflow run ID
 * @param {string|string[]} params.targetNodeIds - Downstream node ID(s) to execute
 * @param {object} params.record - Record being processed
 * @param {object} [params.context] - Execution context
 * @param {string} [params.event] - Event name
 * @returns {Promise<object>}
 */
export async function resumeNodeGraphExecution({
  workflow,
  runId,
  targetNodeIds,
  record,
  context = {},
  event,
}) {
  const normalizedTargets = Array.isArray(targetNodeIds)
    ? targetNodeIds
    : [targetNodeIds].filter(Boolean);

  return await executeNodeGraph(workflow, event, record, {
    ...context,
    runId,
    startNodeIds: normalizedTargets,
    isResume: true,
  });
}

export async function executeLegacyWorkflow(flow, event, record, context = {}) {
  const db = await readDb();
  const settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
  return executeFlow(flow, event, record, settings, context);
}

async function executeFlow(flow, event, record, settings, context = {}) {
  const actions = Array.isArray(flow.actions) ? flow.actions.filter(action => action && action.type) : [];

  let runId = context.runId;
  if (!runId) {
    const run = await createRunRecord({ workflow: flow, event, context });
    if (run) runId = run.id;
  }

  if (!actions.length) {
    if (runId) {
      await updateRunRecord(runId, {
        status: 'success',
        steps: [],
        error_message: null
      });
    }
    return { runId, steps: [], status: 'success' };
  }

  const resource = context.resource || RESOURCE_BY_EVENT_PREFIX[String(flow.event || '').split('.')[0]];
  const outbound = [];
  const stepsLog = [];
  let hasErrors = false;
  let finalErrorMessage = null;

  try {
    await mutateDb(async db => {
      for (let index = 0; index < actions.length; index++) {
        const action = actions[index];
        let actionError = null;
        let actionResult = null;
        try {
          const messages = await runAction(db, action, record, {
            resource,
            flowId: flow.id,
            flowName: flow.name,
            ...context
          });
          if (Array.isArray(messages)) outbound.push(...messages);
          actionResult = { executed: true, messagesCount: Array.isArray(messages) ? messages.length : 0 };
        } catch (err) {
          actionError = err;
          hasErrors = true;
          if (!finalErrorMessage) finalErrorMessage = err.message;
        }

        stepsLog.push({
          nodeId: action.id || `step_${index + 1}`,
          nodeType: 'action',
          nodeName: action.title || action.name || action.type || 'Action',
          status: actionError ? 'failed' : 'success',
          output: actionResult,
          error: actionError?.message || null,
          executedAt: new Date().toISOString()
        });
      }
      db.audit.unshift({
        id: id('audit'),
        action: `Workflow "${flow.name}" executed (${flow.event})`,
        actor: 'Workflow',
        createdAt: now()
      });
    });
  } catch (err) {
    hasErrors = true;
    if (!finalErrorMessage) finalErrorMessage = err.message;
  }

  if (runId) {
    await updateRunRecord(runId, {
      status: hasErrors ? 'failed' : 'success',
      steps: stepsLog,
      error_message: finalErrorMessage || null
    });
  }

  await deliverMessages(outbound, settings);
  return { runId, steps: stepsLog, status: hasErrors ? 'failed' : 'success' };
}

export async function triggerWorkflows(resourceOrEvent, eventOrRecord, recordOrContext, maybeContext) {
  let resource;
  let event;
  let record;
  let context = {};

  if (typeof resourceOrEvent === 'string' && (resourceOrEvent.includes('.') || !eventOrRecord || typeof eventOrRecord === 'object')) {
    event = resourceOrEvent;
    record = eventOrRecord || {};
    context = recordOrContext || {};
    resource = context.resource || RESOURCE_BY_EVENT_PREFIX[event.split('.')[0]] || event.split('.')[0];
  } else {
    resource = resourceOrEvent;
    event = eventOrRecord;
    record = recordOrContext || {};
    context = maybeContext || {};
    if (!context.resource && resource) {
      context.resource = resource;
    }
  }

  try {
    const db = await readDb();
    if (record._workflow) return;

    const flows = (db.workflows || []).filter(flow => {
      if (!flow.enabled) return false;
      if (flow.event === event) return true;
      if (!flow.event && Array.isArray(flow.nodes) && flow.nodes.length > 0) {
        const trigger = flow.nodes.find(n => n.type === 'trigger' || n.type === 'start');
        const triggerEvent = trigger?.config?.event || trigger?.data?.event || trigger?.event;
        if (!triggerEvent || triggerEvent === event) return true;
      }
      return false;
    });

    if (!flows.length) return;

    for (const flow of flows) {
      if (!matchesFilter(flow, record)) continue;
      const run = await createRunRecord({ workflow: flow, event, context });
      const flowContext = { ...context, runId: run?.id };
      if (Array.isArray(flow.nodes) && flow.nodes.length > 0) {
        await executeNodeGraph(flow, event, record, flowContext);
      } else {
        await executeLegacyWorkflow(flow, event, record, flowContext);
      }
    }
  } catch (error) {
    console.error(`[workflows] ${resource}:${event} failed:`, error.message);
  }
}

// Dry-run a node graph against a sample record without persisting anything.
export function dryRunFlow(flow, record) {
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  if (!nodes.length) return { steps: [], executed: 0 };

  const outgoing = getOutgoingEdges(flow);
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  let triggerNodes = nodes.filter(n => n.type === 'trigger' || n.type === 'start');
  if (!triggerNodes.length) {
    const targetIds = new Set();
    for (const list of outgoing.values()) {
      for (const edge of list) targetIds.add(edge.target);
    }
    const rootNodes = nodes.filter(n => !targetIds.has(n.id));
    triggerNodes = rootNodes.length ? rootNodes : [nodes[0]];
  }

  const steps = [];
  const visited = new Set();
  const queue = [...triggerNodes.map(n => n.id)];
  let guard = 0;

  while (queue.length > 0 && guard++ < 200) {
    const nodeId = queue.shift();
    if (visited.has(nodeId)) {
      steps.push({ node: nodeId, type: nodeMap.get(nodeId)?.type || 'unknown', result: 'loop-guard' });
      continue;
    }
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) continue;

    if (node.type === 'trigger' || node.type === 'start') {
      steps.push({ node: node.id, type: node.type, result: 'start' });
      const edges = outgoing.get(node.id) || [];
      for (const edge of edges) {
        if (!visited.has(edge.target)) queue.push(edge.target);
      }
      continue;
    }

    if (node.type === 'condition') {
      const config = node.config || node.data || node;
      const passes = evaluateCondition(config, record);
      steps.push({ node: node.id, type: 'condition', result: passes ? 'true' : 'false', config });
      const edges = getConditionEdges(outgoing.get(node.id) || [], passes);
      for (const edge of edges) {
        if (!visited.has(edge.target)) queue.push(edge.target);
      }
      continue;
    }

    if (node.type === 'delay') {
      steps.push({
        node: node.id,
        type: 'delay',
        result: 'scheduled',
        minutes: Number(node.config?.minutes ?? node.data?.minutes ?? 0)
      });
      const edges = outgoing.get(node.id) || [];
      for (const edge of edges) {
        if (!visited.has(edge.target)) queue.push(edge.target);
      }
      continue;
    }

    if (node.type === 'wait') {
      const delayRaw = node.config?.delay ?? node.data?.delay ?? node.config?.duration ?? node.data?.duration;
      const delayMs = parseDelayToMs(delayRaw);
      steps.push({
        node: node.id,
        type: 'wait',
        result: 'waiting',
        delay: delayRaw,
        delayMs
      });
      const edges = outgoing.get(node.id) || [];
      for (const edge of edges) {
        if (!visited.has(edge.target)) queue.push(edge.target);
      }
      continue;
    }

    if (node.type === 'action') {
      const actionType = node.config?.type || node.data?.type || node.action || 'action';
      steps.push({
        node: node.id,
        type: 'action',
        result: normalizeActionType(actionType),
        config: node.config || node.data || {}
      });
      const edges = outgoing.get(node.id) || [];
      for (const edge of edges) {
        if (!visited.has(edge.target)) queue.push(edge.target);
      }
      continue;
    }

    steps.push({ node: node.id, type: node.type, result: 'end' });
    const edges = outgoing.get(node.id) || [];
    for (const edge of edges) {
      if (!visited.has(edge.target)) queue.push(edge.target);
    }
  }

  return { steps, executed: steps.filter(s => s.type === 'action').length };
}