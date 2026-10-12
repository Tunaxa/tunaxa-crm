import { readDb, mutateDb } from "../store.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { id, now, completeCall } from "../helpers.js";
import { getSettings, isTwilioConfigured } from "../services/config.js";
import {
  createOutboundCall,
  validateSignature,
  voiceTwiML,
  downloadTwilioRecording,
} from "../services/twilio.js";
import { transcribeAudio } from "../services/ai.js";
import { isAiConfigured } from "../services/config.js";
import { queueTranscriptionJob } from "../services/transcriptionQueue.js";
import { triggerWorkflows } from "../services/workflows.js";
import {
  validate,
  DialSchema,
  CompleteCallSchema,
} from "../services/validate.js";
import { createRateLimiter } from "../services/rateLimit.js";

const providerLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  prefix: "provider",
});

async function twilioSignatureOk(req) {
  const settings = await getSettings();
  // Fail closed: if Twilio is not configured, never accept unsigned callbacks.
  if (!settings.twilioToken) return false;
  // Twilio signs the full public URL it called. When publicBaseUrl is set, use it
  // (plus the request path) so the signature matches even behind a TLS-terminating
  // proxy where the internal host differs from the public host.
  const base = settings.publicBaseUrl
    ? String(settings.publicBaseUrl).replace(/\/+$/, "")
    : "";
  const url = base
    ? `${base}${req.originalUrl}`
    : `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  return validateSignature(
    settings,
    url,
    req.get("X-Twilio-Signature"),
    req.body || {},
  );
}

export default function registerCallRoutes(app) {
  app.post(
    "/api/calls/:id/complete",
    auth,
    requireRole("admin", "member"),
    validate(CompleteCallSchema),
    async (req, res) => {
      const result = await mutateDb((db) => {
        const call = db.calls.find((item) => item.id === req.params.id);
        if (!call) return null;
        return completeCall(db, call, {
          endedAt: req.body.endedAt,
          duration: req.body.duration,
          actorName: req.user.name,
        });
      });
      if (!result) return res.status(404).json({ error: "Call not found" });
      triggerWorkflows("calls", "call.completed", result.call);
      res.json(result);
    },
  );

  app.post(
    "/api/calls/dial",
    auth,
    requireRole("admin", "member"),
    providerLimiter,
    validate(DialSchema),
    async (req, res) => {
      const phone = req.body.phone;
      const contact = req.body.contact || "";
      const settings = await getSettings();
      if (!isTwilioConfigured(settings))
        return res
          .status(400)
          .json({ error: "Twilio is not configured in Settings" });
      if (!settings.publicBaseUrl)
        return res
          .status(400)
          .json({
            error:
              "Set a public webhook URL (publicBaseUrl) in Settings before placing Twilio calls",
          });
      const createdAt = now();
      let call;
      await mutateDb((db) => {
        call = {
          id: id("call"),
          phone,
          contact,
          direction: "Outbound",
          status: "Dialing",
          provider: "Twilio",
          startedAt: createdAt,
          duration: 0,
          createdAt,
          updatedAt: createdAt,
        };
        db.calls.unshift(call);
        db.audit.unshift({
          id: id("audit"),
          action: `Dialed ${phone} via Twilio`,
          actor: req.user.name,
          createdAt,
        });
      });
      const base = settings.publicBaseUrl.replace(/\/+$/, "");
      try {
        const out = await createOutboundCall(settings, {
          to: phone,
          voiceUrl: `${base}/api/twilio/voice?to=${encodeURIComponent(phone)}&callId=${call.id}`,
          statusCallback: `${base}/api/twilio/status`,
        });
        const updated = await mutateDb((db) => {
          const index = db.calls.findIndex((x) => x.id === call.id);
          if (index < 0) return call;
          db.calls[index].twilioCallSid = out.sid;
          db.calls[index].providerStatus = out.status;
          db.calls[index].updatedAt = now();
          return { ...db.calls[index] };
        });
        res.status(201).json(updated);
      } catch (error) {
        await mutateDb((db) => {
          const index = db.calls.findIndex((x) => x.id === call.id);
          if (index >= 0) {
            db.calls[index].status = "Failed";
            db.calls[index].error = error.message;
            db.calls[index].updatedAt = now();
          }
        });
        res.status(502).json({ error: error.message, call });
      }
    },
  );

  async function twilioVoice(req, res) {
    const settings = await getSettings();
    if (!(await twilioSignatureOk(req)))
      return res.status(403).send("Invalid signature");
    const to = String(req.query.to || req.body?.To || "").trim();
    const callId = String(req.query.callId || req.body?.CallSid || "");
    if (callId) {
      await mutateDb((db) => {
        const index = db.calls.findIndex((x) => x.id === callId);
        if (index >= 0) {
          db.calls[index].status = "Connected";
          db.calls[index].providerStatus = "in-progress";
          db.calls[index].updatedAt = now();
        }
      });
    }
    res
      .type("text/xml")
      .send(
        voiceTwiML({
          dialTarget: to,
          callerId: settings.twilioNumber,
          record: settings.callRecording !== false,
          voicemailDetection: settings.voicemailDetection,
        }),
      );
  }
  app.get("/api/twilio/voice", twilioVoice);
  app.post("/api/twilio/voice", twilioVoice);

  app.post("/api/twilio/status", async (req, res) => {
    if (!(await twilioSignatureOk(req)))
      return res.status(403).send("Invalid signature");
    const { CallSid, CallStatus, CallDuration } = req.body || {};
    const db = await readDb();
    const call =
      db.calls.find((x) => x.twilioCallSid === CallSid) ||
      db.calls.find((x) => x.phone === String(req.body?.Called || ""));
    if (call) {
      const statusMap = {
        ringing: "Ringing",
        "in-progress": "Connected",
        completed: "Completed",
        busy: "No answer",
        "no-answer": "No answer",
        failed: "Failed",
        canceled: "Canceled",
        "machine-detected": "Voicemail",
      };
      const mapped = statusMap[CallStatus] || CallStatus || call.status;
      if (mapped === "Completed") {
        await mutateDb((db) => {
          const target = db.calls.find((x) => x.id === call.id);
          if (target)
            completeCall(db, target, {
              endedAt: now(),
              duration: Number(CallDuration || 0),
              actorName: "Twilio",
            });
        });
        const fresh = (await readDb()).calls.find((x) => x.id === call.id);
        if (fresh) triggerWorkflows("calls", "call.completed", fresh);
      } else {
        await mutateDb((db) => {
          const target = db.calls.find((x) => x.id === call.id);
          if (target) {
            target.status = mapped;
            target.providerStatus = CallStatus;
            target.updatedAt = now();
          }
        });
      }
    }
    res.send("<Response/>");
  });

  app.post("/api/twilio/recording", async (req, res) => {
    const settings = await getSettings();
    if (!(await twilioSignatureOk(req)))
      return res.status(403).send("Invalid signature");
    const { RecordingSid, RecordingUrl, CallSid, Duration } = req.body || {};
    if (!RecordingSid) return res.send("<Response/>");
    let recording;
    await mutateDb((db) => {
      const call = db.calls.find((x) => x.twilioCallSid === CallSid);
      const createdAt = now();
      let rec =
        db.recordings.find((x) => x.providerSid === RecordingSid) ||
        (call && db.recordings.find((x) => x.callId === call.id));
      if (rec) {
        rec.providerSid = RecordingSid;
        rec.fileUrl = RecordingUrl || rec.fileUrl;
        rec.mimeType = "audio/mpeg";
        rec.mediaStatus = "Audio ready";
        rec.source = "Twilio";
        if (Duration) rec.duration = Number(Duration) || rec.duration;
        rec.updatedAt = createdAt;
      } else {
        rec = {
          id: id("recording"),
          title: `Call recording · ${call?.contact || call?.phone || "Unknown number"}`,
          contact: call?.contact || "",
          phone: call?.phone || "",
          duration: Number(Duration || 0),
          transcript: "",
          summary: "",
          fileUrl: RecordingUrl || "",
          originalName: "",
          mimeType: "audio/mpeg",
          mediaStatus: "Audio ready",
          source: "Twilio",
          providerSid: RecordingSid,
          callId: call?.id || "",
          createdAt,
          updatedAt: createdAt,
        };
        db.recordings.unshift(rec);
      }
      db.audit.unshift({
        id: id("audit"),
        action: "Twilio recording received",
        actor: "Twilio",
        createdAt,
      });
      recording = { ...rec };
    });
    if (
      settings.autoTranscribeRecordings &&
      isAiConfigured(settings) &&
      recording.fileUrl
    ) {
      queueTranscriptionJob({
        recordingId: recording.id,
        fileUrl: recording.fileUrl,
        fileName: `recording-${recording.id}.mp3`,
        mimeType: "audio/mpeg",
        workspaceId: "default",
      }).catch((error) => {
        console.error("[twilio] auto-transcription queue failed:", error.message);
      });
    }
    res.send("<Response/>");
  });
}
