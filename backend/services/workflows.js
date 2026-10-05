import crypto from 'node:crypto';
import { readDb, mutateDb } from '../store.js';
import { DEFAULT_SETTINGS } from './config.js';
import { runAction, deliverMessages } from './actions.js';
import { matchCondition, matchConditions } from './conditions.js';
import { scheduleExecution } from './queue.js';

const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const now = () => new Date().toISOString();

const RESOURCE_BY_EVENT_PREFIX = {
  lead: 'leads',
  contact: 'contacts',
  company: 'companies',
  deal: 'deals',
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
  { value: 'webhook.received', label: 'Webhook received', resource: 'webhookEndpoints' }
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
  condition: { label: 'If / Else branch' },
  delay: { label: 'Wait & schedule' },
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
  employees: 'employee.created', leaveRequests: 'leaveRequest.created', attendance: 'attendance.created'
}[resource] || null);

export const updatedEvent = resource => ({
  leads: 'lead.updated', contacts: 'contact.updated', companies: 'company.updated', deals: 'deal.updated', tasks: 'task.updated',
  products: 'product.updated', orders: 'order.updated', invoices: 'invoice.updated', expenses: 'expense.updated',
  campaigns: 'campaign.updated', emailLists: 'emailList.updated', landingPages: 'landingPage.updated',
  employees: 'employee.updated', leaveRequests: 'leaveRequest.updated', attendance: 'attendance.updated'
}[resource] || null);

export async function triggerWorkflows(resource, event, record) {
  try {
    const db = await readDb();
    const settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
    const flows = (db.workflows || []).filter(flow => flow.enabled && flow.event === event);
    if (!flows.length || record._workflow) return;

    for (const flow of flows) {
      if (!matchesFilter(flow, record)) continue;
      if (Array.isArray(flow.nodes) && flow.nodes.length) {
        await executeFlowNodes(flow, record, settings);
      } else {
        await executeFlow(flow, record, settings);
      }
    }
  } catch (error) {
    console.error(`[workflows] ${resource}:${event} failed:`, error.message);
  }
}

async function executeFlow(flow, record, settings) {
  const actions = Array.isArray(flow.actions) ? flow.actions.filter(action => action && action.type) : [];
  if (!actions.length) return;

  const resource = RESOURCE_BY_EVENT_PREFIX[String(flow.event || '').split('.')[0]];
  const outbound = [];

  await mutateDb(async db => {
    for (const action of actions) {
      const messages = await runAction(db, action, record, { resource, flowId: flow.id, flowName: flow.name });
      outbound.push(...messages);
    }
    db.audit.unshift({ id: id('audit'), action: `Workflow "${flow.name}" executed (${flow.event})`, actor: 'Workflow', createdAt: now() });
  });

  await deliverMessages(outbound, settings);
}

// Node-graph executor: supports condition (if/else) branching and delay nodes.
async function executeFlowNodes(flow, record, settings) {
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const start = nodes.find(n => n.type === 'start') || nodes[0];
  if (!start) return;

  const resource = RESOURCE_BY_EVENT_PREFIX[String(flow.event || '').split('.')[0]];
  const outbound = [];
  const visited = new Set();

  await mutateDb(async db => {
    let node = start;
    let guard = 0;
    while (node && guard++ < 50) {
      if (visited.has(node.id)) break;
      visited.add(node.id);

      if (node.type === 'start') {
        node = nodes.find(n => n.id === node.next);
        continue;
      }

      if (node.type === 'condition') {
        const config = node.config || {};
        const passes = Array.isArray(config.conditions)
          ? matchConditions(record, config.conditions, config.logic)
          : matchCondition(record, config);
        node = nodes.find(n => n.id === (passes ? node.trueNext : node.falseNext));
        continue;
      }

      if (node.type === 'delay') {
        const minutes = Number(node.config?.minutes) || 0;
        if (node.config?.action?.type) {
          const dueAt = new Date(Date.now() + minutes * 60000).toISOString();
          scheduleExecution(db, { flowId: flow.id, flowName: flow.name, resource, record, action: node.config.action, dueAt });
          db.audit.unshift({ id: id('audit'), action: `Workflow "${flow.name}" scheduled a delayed action`, actor: 'Workflow', createdAt: now() });
        }
        node = nodes.find(n => n.id === node.next);
        continue;
      }

      if (node.type === 'action') {
        const action = { ...(node.config || {}), type: node.config?.type || node.action };
        const messages = await runAction(db, action, record, { resource, flowId: flow.id, flowName: flow.name });
        outbound.push(...messages);
        node = nodes.find(n => n.id === node.next);
        continue;
      }

      break;
    }
    db.audit.unshift({ id: id('audit'), action: `Workflow "${flow.name}" executed (${flow.event})`, actor: 'Workflow', createdAt: now() });
  });

  await deliverMessages(outbound, settings);
}

// Dry-run a node graph against a sample record without persisting anything.
export function dryRunFlow(flow, record) {
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const start = nodes.find(n => n.type === 'start') || nodes[0];
  if (!start) return { steps: [], executed: 0 };
  const steps = [];
  const visited = new Set();
  let node = start;
  let guard = 0;
  while (node && guard++ < 50) {
    if (visited.has(node.id)) {
      steps.push({ node: node.id, type: node.type, result: 'loop-guard' });
      break;
    }
    visited.add(node.id);
    if (node.type === 'start') {
      steps.push({ node: node.id, type: 'start', result: 'start' });
      node = nodes.find(n => n.id === node.next);
      continue;
    }
    if (node.type === 'condition') {
      const config = node.config || {};
      const passes = Array.isArray(config.conditions)
        ? matchConditions(record, config.conditions, config.logic)
        : matchCondition(record, config);
      steps.push({ node: node.id, type: 'condition', result: passes ? 'true' : 'false', config });
      node = nodes.find(n => n.id === (passes ? node.trueNext : node.falseNext));
      continue;
    }
    if (node.type === 'delay') {
      steps.push({ node: node.id, type: 'delay', result: 'scheduled', minutes: Number(node.config?.minutes) || 0 });
      node = nodes.find(n => n.id === node.next);
      continue;
    }
    if (node.type === 'action') {
      steps.push({ node: node.id, type: 'action', result: node.config?.type || node.action, config: node.config || {} });
      node = nodes.find(n => n.id === node.next);
      continue;
    }
    steps.push({ node: node.id, type: node.type, result: 'end' });
    break;
  }
  return { steps, executed: steps.filter(s => s.type === 'action').length };
}