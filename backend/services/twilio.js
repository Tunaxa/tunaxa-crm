import crypto from 'node:crypto';
import { retryWithBackoff } from './retry.js';

const API = 'https://api.twilio.com/2010-04-01';

function authHeader(settings) {
  const token = Buffer.from(`${settings.twilioSid}:${settings.twilioToken}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

async function apiRequest(settings, method, path, form = {}) {
  const url = `${API}/Accounts/${settings.twilioSid}/${path}`;
  const response = await fetch(url, {
    method,
    headers: authHeader(settings),
    body: new URLSearchParams(form).toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Twilio request failed (${response.status})`);
  }
  return data;
}

// Twilio's signature algorithm HMACs the request URL followed by each body
// parameter, where both the key and value must be RFC 3986 URL-encoded and the
// parameters sorted by key (byte order). Failing to URL-encode causes valid
// callbacks containing characters like '+', '&' or '=' to be rejected.
function twilioEncode(input) {
  return encodeURIComponent(String(input ?? '')).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function validateSignature(settings, url, signature, body) {
  if (!settings.twilioToken || !signature) return false;
  const hmac = crypto.createHmac('sha1', settings.twilioToken);
  let payload = url;
  if (body && typeof body === 'object') {
    const entries = Object.entries(body).sort(([a], [b]) => a.localeCompare(b));
    payload += entries.map(([key, value]) => `${twilioEncode(key)}${twilioEncode(value)}`).join('');
  }
  hmac.update(payload);
  const expected = hmac.digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function createOutboundCall(settings, { to, voiceUrl, statusCallback }) {
  const form = {
    To: to,
    From: settings.twilioNumber,
    Url: voiceUrl,
    StatusCallback: statusCallback,
    StatusCallbackEvent: 'initiated ringing answered completed',
    Record: 'true'
  };
  const call = await apiRequest(settings, 'POST', 'Calls.json', form);
  return { sid: call.sid, status: call.status, direction: call.direction };
}

export async function sendSms(settings, { to, body }) {
  const message = await apiRequest(settings, 'POST', 'Messages.json', {
    To: to,
    From: settings.twilioNumber,
    Body: body
  });
  return { delivered: true, status: 'Sent', providerId: message.sid || '' };
}

export async function downloadTwilioRecording(settings, recordingUrl) {
  const url = String(recordingUrl || '').replace(/^https?:\/\//, 'https://');
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('Invalid recording URL');
  }
  if (host !== 'twilio.com' && !host.endsWith('.twilio.com')) {
    throw new Error('Recording URL must point to Twilio');
  }
  const audioUrl = url.endsWith('.mp3') ? url : `${url}.mp3`;
  const buffer = await retryWithBackoff(async () => {
    const response = await fetch(audioUrl, { headers: authHeader(settings) });
    if (!response.ok) throw new Error(`Could not download recording (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }, { attempts: 3 });
  return buffer;
}

export const escapeXml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

export function voiceTwiML({ dialTarget, callerId, record, voicemailDetection }) {
  const attributes = [
    `callerId="${escapeXml(callerId)}"`,
    record ? 'record="record-from-answer"' : '',
    voicemailDetection ? 'machineDetection="DetectMessageEnd"' : ''
  ].filter(Boolean).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial ${attributes}>${escapeXml(dialTarget)}</Dial></Response>`;
}
