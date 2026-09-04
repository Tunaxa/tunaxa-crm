import { id, now } from '../helpers.js';
import { mutateDb } from '../store.js';
import { isEmailConfigured, isTwilioConfigured } from './config.js';
import { sendEmail } from './smtp.js';
import { sendSms } from './twilio.js';

export function render(template, record) {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = key.split('.').reduce((obj, part) => (obj && typeof obj === 'object' ? obj[part] : undefined), record);
    return value === undefined || value === null ? '' : String(value);
  });
}

// Applies a single workflow action to the mutable db snapshot.
// Returns an array of outbound messages (email/sms) that still need delivery.
export function runAction(db, action, record, { resource, flowId = '', flowName = '' } = {}) {
  const messages = [];
  if (!action || !action.type) return messages;
  const createdAt = now();

  if (action.type === 'task') {
    db.tasks.unshift({
      id: id('task'),
      title: render(action.title, record) || 'Workflow task',
      owner: render(action.owner, record),
      priority: action.priority || 'Medium',
      status: 'Open',
      dueDate: action.dueDate || '',
      source: 'workflow',
      workflowId: flowId,
      createdAt,
      updatedAt: createdAt
    });
    db.audit.unshift({ id: id('audit'), action: `Workflow "${flowName}" created a task`, actor: 'Workflow', createdAt });
  }

  if (action.type === 'activity') {
    db.activities.unshift({
      id: id('activity'),
      title: render(action.title, record) || 'Workflow activity',
      type: action.subtype || action.type || 'Note',
      contact: record.email || record.phone || '',
      notes: render(action.notes, record),
      date: createdAt.slice(0, 10),
      source: 'workflow',
      workflowId: flowId,
      createdAt,
      updatedAt: createdAt
    });
    db.audit.unshift({ id: id('audit'), action: `Workflow "${flowName}" logged an activity`, actor: 'Workflow', createdAt });
  }

  if (action.type === 'email' || action.type === 'sms') {
    const message = {
      id: id('message'),
      channel: action.type === 'email' ? 'Email' : 'SMS',
      to: render(action.to, record) || '',
      subject: action.type === 'email' ? render(action.subject, record) : '',
      body: render(action.body, record) || '',
      direction: 'Outbound',
      status: 'Queued',
      source: 'workflow',
      workflowId: flowId,
      contact: record.email || record.phone || '',
      createdAt,
      updatedAt: createdAt
    };
    db.messages.unshift(message);
    messages.push(message);
  }

  if (action.type === 'update' && action.field && record.id) {
    const target = resource && db[resource] ? resource : null;
    if (target) {
      const index = db[target].findIndex(item => item.id === record.id);
      if (index >= 0) {
        db[target][index] = { ...db[target][index], [action.field]: render(action.value, record), updatedAt: createdAt };
        db.audit.unshift({ id: id('audit'), action: `Workflow "${flowName}" updated ${action.field}`, actor: 'Workflow', createdAt });
      }
    }
  }

  return messages;
}

// Delivers outbound email/SMS messages and persists delivery status on each message row.
export async function deliverMessages(messages, settings) {
  for (const message of messages) {
    let result;
    if (message.channel === 'SMS') {
      result = isTwilioConfigured(settings)
        ? await sendSms(settings, { to: message.to, body: message.body })
        : { delivered: false, status: 'Saved', error: 'Twilio is not configured' };
    } else {
      result = isEmailConfigured(settings)
        ? await sendEmail(settings, { to: message.to, subject: message.subject, text: message.body })
        : { delivered: false, status: 'Saved', error: 'SMTP is not configured' };
    }
    // A transient network/provider error thrown by a single send must not abort
    // the whole batch — record it per-message and keep delivering the rest.
    if (result instanceof Error) {
      result = { delivered: false, status: 'Failed', error: result.message };
    }
    message.status = result.status || 'Failed';
    if (result.providerId) message.providerId = result.providerId;
    if (result.error) message.error = result.error;
    await mutateDb(db => {
      const index = db.messages.findIndex(item => item.id === message.id);
      if (index >= 0) {
        db.messages[index].status = message.status;
        if (message.providerId) db.messages[index].providerId = message.providerId;
        if (message.error) db.messages[index].error = message.error;
        db.messages[index].updatedAt = now();
      }
    }).catch(() => {});
  }
}