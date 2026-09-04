import { mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { id, now } from '../helpers.js';
import { getSettings, isEmailConfigured, isTwilioConfigured } from '../services/config.js';
import { sendEmail } from '../services/smtp.js';
import { sendSms } from '../services/twilio.js';
import { triggerWorkflows } from '../services/workflows.js';
import { validate, MessageSchema } from '../services/validate.js';
import { createRateLimiter } from '../services/rateLimit.js';

const providerLimiter = createRateLimiter({ windowMs: 60_000, max: 30, prefix: 'provider' });

function injectTracking(body, messageId, publicBaseUrl) {
  const baseUrl = publicBaseUrl || 'http://127.0.0.1:3001';
  const pixel = `<img src="${baseUrl}/api/tracking/open/${messageId}" width="1" height="1" style="display:none" alt="" />`;
  let html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#33475b">${body.replace(/\n/g, '<br>')}</div>${pixel}`;
  html = html.replace(/(https?:\/\/[^\s<]+)/g, url => `<a href="${baseUrl}/api/tracking/click/${messageId}?url=${encodeURIComponent(url)}">${url}</a>`);
  return html;
}

export default function registerMessageRoutes(app) {
  app.post('/api/messages/send', auth, requireRole('admin', 'member'), providerLimiter, validate(MessageSchema), async (req, res) => {
    const { id: existingId, idempotencyKey, channel = 'Email', to, subject, body, contact } = req.body;
    const settings = await getSettings();
    const createdAt = now();
    let message = null;
    let replay = false;
    await mutateDb(db => {
      if (idempotencyKey) {
        const found = db.messages.find(x => x.idempotencyKey === idempotencyKey);
        if (found && found.status === 'Sent') {
          message = { ...found };
          replay = true;
          return;
        }
        // An in-flight (Queued) attempt with the same key is treated as already
        // accepted so a retry doesn't double-send.
        if (found && found.status === 'Queued') {
          message = { ...found };
          replay = true;
          return;
        }
        if (found) message = found;
      }
      if (!message && existingId) {
        const index = db.messages.findIndex(x => x.id === existingId);
        if (index >= 0) message = db.messages[index];
      }
      if (!message) {
        message = { id: id('message'), channel, to: String(to).trim(), subject: subject || '', body: String(body), contact: contact || '', direction: 'Outbound', status: 'Queued', read: true, idempotencyKey: idempotencyKey || '', createdAt, updatedAt: createdAt };
        db.messages.unshift(message);
      } else {
        const index = db.messages.findIndex(x => x.id === message.id);
        if (index >= 0) {
          db.messages[index] = { ...db.messages[index], channel, to, subject, body, contact, status: 'Queued', error: '', read: true, updatedAt: createdAt };
          message = { ...db.messages[index] };
        }
      }
      db.activities.unshift({ id: id('activity'), title: `${channel} to ${message.to}`, type: channel === 'SMS' ? 'SMS' : 'Email', contact: message.to, notes: subject || body, date: createdAt.slice(0, 10), messageId: message.id, createdAt, updatedAt: createdAt });
      db.audit.unshift({ id: id('audit'), action: `Queued ${channel} to ${message.to}`, actor: req.user.name, createdAt });
    });
    if (replay) return res.json(message);

    let result;
    if (message.channel === 'SMS') {
      result = isTwilioConfigured(settings)
        ? await sendSms(settings, { to: message.to, body: message.body })
        : { delivered: false, status: 'Saved', error: 'Twilio is not configured in Settings' };
    } else {
      const track = settings.emailTracking !== false && settings.publicBaseUrl;
      result = isEmailConfigured(settings)
        ? await sendEmail(settings, { to: message.to, subject: message.subject, text: message.body, html: track ? injectTracking(message.body, message.id, settings.publicBaseUrl) : undefined })
        : { delivered: false, status: 'Saved', error: 'SMTP is not configured in Settings' };
    }

    const saved = await mutateDb(db => {
      const index = db.messages.findIndex(x => x.id === message.id);
      if (index < 0) return null;
      db.messages[index].status = result.status || 'Failed';
      if (result.providerId) db.messages[index].providerId = result.providerId;
      if (result.error) db.messages[index].error = result.error;
      db.messages[index].deliveredAt = result.delivered ? createdAt : '';
      db.messages[index].updatedAt = now();
      return { ...db.messages[index] };
    });
    if (saved) triggerWorkflows('messages', 'message.sent', saved);
    res.json(saved);
  });
}
