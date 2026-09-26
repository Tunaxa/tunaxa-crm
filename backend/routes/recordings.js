import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mutateDb } from "../store.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { id, now } from "../helpers.js";
import { getSettings, isAiConfigured } from "../services/config.js";
import { transcribeAudio } from "../services/ai.js";
import { downloadTwilioRecording } from "../services/twilio.js";
import { createRateLimiter } from "../services/rateLimit.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(root, "..", "uploads");
const providerLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  prefix: "provider",
});

export default function registerRecordingRoutes(app, upload) {
  app.post(
    "/api/recordings/upload",
    auth,
    requireRole("admin", "member"),
    providerLimiter,
    upload.single("audio"),
    async (req, res) => {
      if (!req.file)
        return res.status(400).json({ error: "Audio file is required" });
      const record = await mutateDb((db) => {
        const callId = String(req.body.callId || "").trim();
        let item = callId
          ? db.recordings.find((record) => record.callId === callId)
          : null;
        if (item) {
          item.title = req.body.title || item.title || req.file.originalname;
          item.contact = req.body.contact ?? item.contact ?? "";
          item.duration = req.body.duration || item.duration || "";
          item.transcript = req.body.transcript ?? item.transcript ?? "";
          item.fileUrl = `/uploads/${req.file.filename}`;
          item.originalName = req.file.originalname;
          item.mimeType = req.file.mimetype;
          item.mediaStatus = "Audio ready";
          item.updatedAt = now();
        } else {
          item = {
            id: id("recording"),
            title: req.body.title || req.file.originalname,
            contact: req.body.contact || "",
            duration: req.body.duration || "",
            transcript: req.body.transcript || "",
            summary: "",
            fileUrl: `/uploads/${req.file.filename}`,
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            mediaStatus: "Audio ready",
            source: callId ? "Call" : "Upload",
            callId,
            createdAt: now(),
            updatedAt: now(),
          };
          db.recordings.unshift(item);
        }
        db.audit.unshift({
          id: id("audit"),
          action: `Recording media attached: ${item.title}`,
          actor: req.user.name,
          createdAt: now(),
        });
        return item;
      });
      res.status(201).json(record);
    },
  );

  app.post(
    "/api/recordings/:id/summarize",
    auth,
    requireRole("admin", "member"),
    providerLimiter,
    async (req, res) => {
      const settings = await getSettings();
      const record = await mutateDb((db) => {
        const found = db.recordings.find((x) => x.id === req.params.id);
        return found ? { ...found } : null;
      });
      if (!record)
        return res.status(404).json({ error: "Recording not found" });
      const text = String(record.transcript || "")
        .replace(/\s+/g, " ")
        .trim();
      let summary = "";
      let ai = false;
      if (text && isAiConfigured(settings)) {
        try {
          const { summarizeTranscript } = await import("../services/ai.js");
          summary = await summarizeTranscript(settings, {
            transcript: text,
            title: record.title,
            contact: record.contact,
          });
          ai = true;
        } catch {
          summary = text.length > 420 ? `${text.slice(0, 420)}…` : text;
        }
      } else {
        summary = text
          ? text.length > 420
            ? `${text.slice(0, 420)}…`
            : text
          : "No transcript is available yet.";
      }
      const saved = await mutateDb((db) => {
        const found = db.recordings.find((x) => x.id === req.params.id);
        if (!found) return null;
        found.summary = summary;
        found.summaryAi = ai;
        found.updatedAt = now();
        return { ...found };
      });
      if (!saved) return res.status(404).json({ error: "Recording not found" });
      res.json(saved);
    },
  );

  app.post(
    "/api/recordings/:id/transcribe",
    auth,
    requireRole("admin", "member"),
    providerLimiter,
    async (req, res) => {
      const settings = await getSettings();
      if (!isAiConfigured(settings))
        return res
          .status(400)
          .json({ error: "Ollama is not configured in Settings" });
      const record = await mutateDb((db) => {
        const r = db.recordings.find((x) => x.id === req.params.id);
        return r ? { ...r } : null;
      });
      if (!record)
        return res.status(404).json({ error: "Recording not found" });
      if (!record.fileUrl)
        return res
          .status(400)
          .json({ error: "No audio file attached to this recording" });

      let audio;
      if (/^https?:\/\//i.test(String(record.fileUrl))) {
        try {
          const buffer = await downloadTwilioRecording(
            settings,
            record.fileUrl,
          );
          audio = {
            buffer,
            filename: `recording-${record.id}.mp3`,
            mimeType: record.mimeType || "audio/mpeg",
          };
        } catch (error) {
          return res
            .status(400)
            .json({
              error: `Could not fetch provider audio: ${error.message}`,
            });
        }
      } else {
        const filename = path.basename(String(record.fileUrl));
        const filePath = path.join(uploadDir, filename);
        try {
          await fs.access(filePath);
        } catch {
          return res
            .status(400)
            .json({ error: "Audio file is missing on the server" });
        }
        audio = {
          filePath,
          filename,
          mimeType: record.mimeType || "audio/mpeg",
        };
      }

      const transcript = await transcribeAudio(settings, audio);
      let summary = record.summary;
      if (settings.aiSummaries && transcript) {
        try {
          const { summarizeTranscript } = await import("../services/ai.js");
          summary = await summarizeTranscript(settings, {
            transcript,
            title: record.title,
            contact: record.contact,
          });
        } catch (error) {
          console.warn("Recording summarization failed", error.message);
        }
      }
      const saved = await mutateDb((db) => {
        const index = db.recordings.findIndex((x) => x.id === record.id);
        if (index < 0) return null;
        db.recordings[index].transcript = transcript;
        if (summary) {
          db.recordings[index].summary = summary;
          db.recordings[index].summaryAi = true;
        }
        db.recordings[index].mediaStatus = "Transcribed";
        db.recordings[index].updatedAt = now();
        return { ...db.recordings[index] };
      });
      if (!saved) return res.status(404).json({ error: "Recording not found" });
      res.json(saved);
    },
  );
}
