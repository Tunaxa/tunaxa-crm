import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import multer from "multer";
import * as Sentry from "@sentry/node";
import { fileURLToPath } from "node:url";
import { ensureSettingsDefaults } from "./services/config.js";
import { startRateLimitSweeper } from "./services/rateLimit.js";
import { backupDb } from "./services/backup.js";
import { cleanupExpiredSessions } from "./middleware/auth.js";
import registerAuthRoutes from "./routes/auth.js";
import registerHealthRoutes from "./routes/health.js";
import registerResourceRoutes from "./routes/resources.js";
import registerSettingsRoutes from "./routes/settings.js";
import registerCallRoutes from "./routes/calls.js";
import registerRecordingRoutes from "./routes/recordings.js";
import registerMessageRoutes from "./routes/messages.js";
import registerV1ObjectRoutes from "./routes/v1objects.js";
import registerV1AssociationRoutes from "./routes/v1associations.js";
import registerWebhookRoutes from "./routes/webhooks.js";
import registerTemplateRoutes from "./routes/templates.js";
import registerTrackingRoutes from "./routes/tracking.js";
import registerAiRoutes from "./routes/ai.js";
import registerUploadRoutes from "./routes/uploads.js";
import registerAuditRoutes from "./routes/audit.js";
import registerSseRoutes from "./routes/sse.js";
import registerReportRoutes from "./routes/reports.js";
import registerPermissionsRoutes from "./routes/permissions.js";
import registerImportRoutes from "./routes/import.js";
import registerOnboardingRoutes from "./routes/onboarding.js";
import registerListRoutes from "./routes/lists.js";
import registerLifecycleRoutes from "./routes/lifecycle.js";
import registerLeadScoringRoutes from "./routes/leadscoring.js";
import registerPipelineRoutes from "./routes/pipeline.js";
import registerSequenceRoutes from "./routes/sequences.js";
import registerTicketRoutes from "./routes/tickets.js";
import registerSchedulerRoutes from "./routes/scheduler.js";
import registerLiveChatRoutes from "./routes/livechat.js";
import registerKnowledgeRoutes from "./routes/knowledgebase.js";
import registerWebTrackingRoutes, {
  registerWebTrackingAuthRoutes,
} from "./routes/webpixel.js";
import registerRevisionRoutes from "./routes/revisions.js";
import registerWorkflowBuilderRoutes from "./routes/workflowbuilder.js";
import registerExecutionRoutes from "./routes/queue.js";
import registerFormRoutes from "./routes/forms.js";
import registerDashboardRoutes from "./routes/dashboard.js";
import registerModuleRoutes from "./routes/modules.js";
import registerGraphQLRoutes from "./routes/graphql.js";
import registerDataOpsRoutes from "./routes/dataops.js";
import registerWebhookEndpointRoutes from "./routes/webhookendpoints.js";
import registerQuoteRoutes from "./routes/quotes.js";
import registerGoalRoutes from "./routes/goals.js";
import { startWebhookWorker } from "./workers/webhookWorker.js";
import {
  initReportSchedulerWorker,
  closeReportSchedulerQueue,
} from "./workers/reportScheduler.js";
import { processExecutionQueue } from "./services/queue.js";
import { startEmailSync, stopEmailSync } from "./services/emailSync.js";
import {
  startTranscriptionWorker,
  stopTranscriptionWorker,
} from "./services/transcriptionQueue.js";
import { createRateLimiter } from "./services/rateLimit.js";
import { initCache } from "./services/cache.js";
import { seedPlaybooks } from "./services/seedPlaybooks.js";

const app = express();
app.disable("x-powered-by");

if (process.env.SENTRY_DSN && process.env.VITEST !== "true") {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.2,
  });
  app.use(Sentry.Handlers.requestHandler());
}
const root = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(root, "uploads");
await fs.mkdir(uploadDir, { recursive: true });

const AUDIO_MIME = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/x-m4a",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
  "audio/x-flac",
  "audio/aiff",
  "audio/x-aiff",
]);
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, done) =>
    done(
      null,
      `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`,
    ),
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (AUDIO_MIME.has(String(file.mimetype || "").toLowerCase()))
      return cb(null, true);
    const error = new Error("Only audio files are allowed");
    error.status = 400;
    cb(error, false);
  },
});

const GENERAL_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
  "application/zip",
]);
const generalUpload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (GENERAL_MIME.has(String(file.mimetype || "").toLowerCase()))
      return cb(null, true);
    const error = new Error("File type not allowed");
    error.status = 400;
    cb(error, false);
  },
});

await ensureSettingsDefaults();
await cleanupExpiredSessions();
if (process.env.VITEST !== "true") await seedPlaybooks();
backupDb("boot").catch((error) =>
  console.error("[backup] boot backup failed:", error.message),
);
setInterval(
  () =>
    backupDb().catch((error) =>
      console.error("[backup] scheduled backup failed:", error.message),
    ),
  6 * 60 * 60 * 1000,
).unref();
startRateLimitSweeper();
initCache();

app.use((req, res, next) => {
  req.id = crypto.randomUUID().slice(0, 8);
  res.setHeader("X-Request-Id", req.id);
  res.setHeader("X-Content-Type-Options", "nosniff");
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const who = req.user ? ` user=${req.user.id}` : "";
    const line = `${new Date().toISOString()} [${req.id}] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${ms.toFixed(1)}ms${who}`;
    if (res.statusCode >= 400) console.error(line);
    else console.log(line);
  });
  next();
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const globalLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 120,
  prefix: "global",
});
app.use("/api", globalLimiter);
app.use(
  "/uploads",
  express.static(uploadDir, {
    setHeaders: (res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", "inline");
    },
  }),
);

// V1 Dynamic Object API (PostgreSQL + JSONB) — registered BEFORE legacy routes
registerV1ObjectRoutes(app);
registerV1AssociationRoutes(app);
registerWebhookRoutes(app);

registerAuthRoutes(app);
registerHealthRoutes(app);
registerSettingsRoutes(app);
registerCallRoutes(app);
registerRecordingRoutes(app, upload);
registerMessageRoutes(app);
registerTemplateRoutes(app);
registerTrackingRoutes(app);
registerAiRoutes(app);
registerUploadRoutes(app, generalUpload);
registerAuditRoutes(app);
registerSseRoutes(app);
registerReportRoutes(app);
registerPermissionsRoutes(app);
registerImportRoutes(app, generalUpload);
registerOnboardingRoutes(app);
registerListRoutes(app);
registerLifecycleRoutes(app);
registerLeadScoringRoutes(app);
registerPipelineRoutes(app);
registerSequenceRoutes(app);
registerTicketRoutes(app);
registerSchedulerRoutes(app);
registerLiveChatRoutes(app);
registerKnowledgeRoutes(app);
registerWebTrackingRoutes(app);
registerWebTrackingAuthRoutes(app);
registerRevisionRoutes(app);
registerWorkflowBuilderRoutes(app);
registerExecutionRoutes(app);
registerFormRoutes(app);
registerDashboardRoutes(app);
registerModuleRoutes(app);
registerGraphQLRoutes(app);
registerDataOpsRoutes(app);
registerWebhookEndpointRoutes(app);
registerQuoteRoutes(app);
registerGoalRoutes(app);
registerResourceRoutes(app);

// ============================================
// Production static assets
// ============================================
// In development the UI is served by the Vite dev server (web/vite.config.ts
// proxies /api and /uploads here), so this block is inert: it only activates
// when a production bundle exists, which is what the Dockerfile produces. That
// keeps every existing test and dev workflow on the same code path it had
// before - there is no web/dist in a checkout, so nothing is mounted.
//
// The fallback is registered as a bare app.use rather than app.get("*") on
// purpose: Express 5 replaced path-to-regexp's bare "*" with named wildcards,
// and a pattern-free middleware cannot break on a future Express upgrade.
// /api and /uploads are excluded so an unknown API route still returns JSON
// 404 rather than the HTML shell.
const webDistDir = path.join(root, "..", "web", "dist");
if (existsSync(path.join(webDistDir, "index.html"))) {
  // index: false - the shell is served explicitly below, so that it can be sent
  // with no-store while the content-hashed assets under /assets stay immutable.
  app.use(express.static(webDistDir, { index: false, maxAge: "1y", immutable: true }));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api") || req.path.startsWith("/uploads")) return next();
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(path.join(webDistDir, "index.html"), (error) => {
      if (error) next(error);
    });
  });
}

app.use((err, req, res, next) => {
  if (process.env.SENTRY_DSN && process.env.VITEST !== "true") {
    Sentry.captureException(err);
  }
  if (res.headersSent) return next(err);
  console.error(`[${req.id || "-"}] Unhandled error:`, err);
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE")
      return res.status(400).json({ error: "File is too large (max 50 MB)" });
    return res.status(400).json({ error: `Upload error: ${err.code}` });
  }
  if (err.status === 400) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: "Internal server error" });
});

export { app };

if (process.env.VITEST !== "true") {
  // Defaults are the pre-existing dev values, so `npm start`, start.js and the
  // Vite proxy in web/vite.config.ts keep working untouched. A container
  // overrides both: PORT selects the published port and HOST must be 0.0.0.0,
  // because a server bound to 127.0.0.1 inside a container is unreachable from
  // the host no matter what the port mapping says.
  const port = Number(process.env.PORT) || 3001;
  const host = process.env.HOST || "127.0.0.1";
  app.listen(port, host, () => {
    console.log(`Tunaxa API running on http://${host}:${port}`);
    startWebhookWorker();
    startEmailSync();
    startTranscriptionWorker();
    initReportSchedulerWorker().catch((error) =>
      console.error("[report-scheduler] worker init failed:", error.message),
    );
  });
  setInterval(
    () =>
      processExecutionQueue().catch((error) =>
        console.error("[queue] worker failed:", error.message),
      ),
    30_000,
  ).unref();

  const shutdown = () => {
    stopEmailSync();
    stopTranscriptionWorker().catch(() => {});
    closeReportSchedulerQueue().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
