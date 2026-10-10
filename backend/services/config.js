import { readDb, mutateDb } from "../store.js";

export const DEFAULT_SETTINGS = {
  workspaceName: "Tunaxa",
  currency: "USD",
  timezone: "Africa/Tunis",
  weekStarts: "Monday",
  callRecording: true,
  localPresence: false,
  voicemailDetection: true,
  emailTracking: true,
  twoWaySms: true,
  aiTranscription: false,
  aiSummaries: false,
  dealRisk: false,
  realTimeCoaching: false,
  smtpHost: "",
  smtpPort: "587",
  smtpUser: "",
  smtpPass: "",
  smtpSecure: false,
  emailProvider: "smtp",
  resendApiKey: "",
  sendgridApiKey: "",
  sesRegion: "",
  sesAccessKey: "",
  sesSecretKey: "",
  emailFrom: "",
  twilioSid: "",
  twilioToken: "",
  twilioNumber: "",
  aiProvider: "ollama",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaTranscriptionModel: "whisper",
  ollamaSummaryModel: "gemma3:4b",
  publicBaseUrl: "",
  autoTranscribeRecordings: false,
  // Per-workspace outbound webhook configuration for the integrations
  // backend. Each channel keeps a map of workspace id -> webhook URL; the
  // environment variables (SLACK_WEBHOOK_URL / ZAPIER_WEBHOOK_URL) remain a
  // deployment-level fallback in services/integrations.js.
  integrations: {
    slack: { webhookUrls: {} },
    zapier: { webhookUrls: {} },
  },
};

export async function getSettings() {
  const db = await readDb();
  return { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
}

export async function ensureSettingsDefaults() {
  await mutateDb((db) => {
    db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
  });
}

export const isEmailConfigured = (settings) =>
  Boolean(
    (settings.smtpHost && settings.smtpUser) ||
    settings.resendApiKey ||
    settings.sendgridApiKey ||
    (settings.sesRegion &&
      settings.sesAccessKey &&
      settings.sesSecretKey &&
      settings.sesSecretKey !== "choose_your_own"),
  );
export const isTwilioConfigured = (settings) =>
  Boolean(settings.twilioSid && settings.twilioToken && settings.twilioNumber);
export const isAiConfigured = (settings) => Boolean(settings.ollamaBaseUrl);
