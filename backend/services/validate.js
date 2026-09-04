import { z } from 'zod';

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues.map(i => i.message).join('; ');
      return res.status(400).json({ error: message });
    }
    req.body = result.data;
    next();
  };
}

export const SetupSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  email: z.string().trim().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters')
});

export const LoginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required')
});

export const SettingsSchema = z.object({
  workspaceName: z.string().trim().min(1).optional(),
  currency: z.string().trim().min(1).optional(),
  timezone: z.string().trim().min(1).optional(),
  weekStarts: z.enum(['Monday', 'Sunday']).optional(),
  callRecording: z.boolean().optional(),
  localPresence: z.boolean().optional(),
  voicemailDetection: z.boolean().optional(),
  emailTracking: z.boolean().optional(),
  twoWaySms: z.boolean().optional(),
  aiTranscription: z.boolean().optional(),
  aiSummaries: z.boolean().optional(),
  dealRisk: z.boolean().optional(),
  realTimeCoaching: z.boolean().optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.string().optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  smtpSecure: z.boolean().optional(),
  emailProvider: z.string().optional(),
  resendApiKey: z.string().optional(),
  sendgridApiKey: z.string().optional(),
  sesRegion: z.string().optional(),
  sesAccessKey: z.string().optional(),
  sesSecretKey: z.string().optional(),
  emailFrom: z.string().optional(),
  twilioSid: z.string().optional(),
  twilioToken: z.string().optional(),
  twilioNumber: z.string().optional(),
  aiProvider: z.string().optional(),
  ollamaBaseUrl: z.string().url('Invalid URL').or(z.literal('')).optional(),
  ollamaTranscriptionModel: z.string().optional(),
  ollamaSummaryModel: z.string().optional(),
  publicBaseUrl: z.string().url('Invalid URL').or(z.literal('')).optional(),
  autoTranscribeRecordings: z.boolean().optional()
}).passthrough();

export const DialSchema = z.object({
  phone: z.string().trim().min(1, 'Phone number is required'),
  contact: z.string().optional()
});

export const CompleteCallSchema = z.object({
  endedAt: z.string().optional(),
  duration: z.number().min(0).optional()
}).passthrough();

export const MessageSchema = z.object({
  id: z.string().optional(),
  idempotencyKey: z.string().optional(),
  channel: z.enum(['Email', 'SMS']).default('Email'),
  to: z.string().trim().min(1, 'Recipient is required'),
  subject: z.string().optional(),
  body: z.string().min(1, 'Message body is required'),
  contact: z.string().optional()
}).passthrough();

export const RecordingsUploadSchema = z.object({
  callId: z.string().optional(),
  title: z.string().optional(),
  contact: z.string().optional(),
  duration: z.union([z.string(), z.number()]).optional(),
  transcript: z.string().optional()
}).passthrough();

export const TemplateSchema = z.object({
  name: z.string().trim().min(1, 'Template name is required'),
  subject: z.string().trim().min(1, 'Subject is required'),
  body: z.string().min(1, 'Body is required'),
  channel: z.enum(['Email', 'SMS']).default('Email').optional()
}).passthrough();

export const ResourceSchema = z.record(z.unknown()).refine(
  obj => !Array.isArray(obj) && typeof obj === 'object',
  { message: 'Body must be a JSON object' }
);

export const BatchSchema = z.array(ResourceSchema).min(1, 'Batch must contain at least one item');
