import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Queue, Worker } from "bullmq";
import { readDb, mutateDb } from "../store.js";
import { getSettings, isAiConfigured } from "./config.js";
import { transcribeAudio } from "./ai.js";
import { downloadTwilioRecording } from "./twilio.js";
import { broadcast } from "../routes/sse.js";
import { now } from "../helpers.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(root, "..", "uploads");

export const QUEUE_NAME = "transcription-queue";

export function getRedisConnection() {
  if (process.env.REDIS_URL) {
    return { url: process.env.REDIS_URL };
  }
  if (process.env.REDIS_HOST || process.env.REDIS_PORT) {
    return {
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT) || 6379,
    };
  }
  if (process.env.REDIS_ENABLED === "true") {
    return { url: "redis://127.0.0.1:6380" };
  }
  return null;
}

export class InMemoryTranscriptionQueue {
  constructor(name = QUEUE_NAME) {
    this.name = name;
    this.jobs = [];
    this._counter = 1;
  }

  async add(name, data = {}, opts = {}) {
    const job = {
      id: `transcription_job_${this._counter++}_${Date.now()}`,
      name,
      data,
      opts,
      timestamp: Date.now(),
    };
    this.jobs.push(job);
    return job;
  }

  getJobs() {
    return [...this.jobs];
  }

  clear() {
    this.jobs = [];
  }

  async close() {
    this.jobs = [];
  }
}

let bullQueue = null;
let inMemoryQueue = null;
let worker = null;

export function getTranscriptionQueue({ forceInMemory = false } = {}) {
  const connection = getRedisConnection();
  if (!connection || forceInMemory) {
    if (!inMemoryQueue) {
      inMemoryQueue = new InMemoryTranscriptionQueue(QUEUE_NAME);
    }
    return inMemoryQueue;
  }

  if (!bullQueue) {
    bullQueue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
  }
  return bullQueue;
}

/**
 * Enqueues an asynchronous audio transcription job.
 *
 * @param {object} jobData
 * @param {string} jobData.recordingId - Recording record ID
 * @param {string} [jobData.filePath] - Absolute or relative local path to audio file
 * @param {string} [jobData.fileName] - Original file name
 * @param {string} [jobData.mimeType] - MIME type of audio
 * @param {string} [jobData.fileUrl] - Stored file URL or remote Twilio URL
 * @param {string} [jobData.workspaceId] - Workspace tenant ID
 * @param {string} [jobData.userId] - User ID initiating the upload/transcription
 * @param {Buffer} [jobData.buffer] - Audio buffer if available directly
 * @param {object} [options]
 * @param {boolean} [options.forceInMemory=false]
 * @returns {Promise<object>}
 */
export async function queueTranscriptionJob(jobData, { forceInMemory = false } = {}) {
  const queue = getTranscriptionQueue({ forceInMemory });
  const job = await queue.add("transcribe-audio", jobData, {
    removeOnComplete: true,
    removeOnFail: false,
  });
  return {
    id: job.id,
    jobId: job.id,
    ...jobData,
  };
}

/**
 * Worker handler to process a single transcription job.
 *
 * @param {object} jobData
 * @returns {Promise<object>}
 */
export async function processTranscriptionJob(jobData) {
  if (!jobData || !jobData.recordingId) {
    throw new Error("recordingId is required for transcription job");
  }

  const { recordingId, userId } = jobData;
  const db = await readDb();
  const rec = (db.recordings || []).find((r) => r.id === recordingId);
  if (!rec) {
    throw new Error(`Recording ${recordingId} not found`);
  }

  // Update status to processing
  await mutateDb((currentDb) => {
    const item = currentDb.recordings.find((r) => r.id === recordingId);
    if (item) {
      item.status = "processing";
      item.mediaStatus = "processing";
      item.updatedAt = now();
    }
  });

  try {
    const settings = await getSettings();
    if (!isAiConfigured(settings)) {
      throw new Error("Ollama is not configured in Settings");
    }

    let audio;
    if (jobData.buffer) {
      audio = {
        buffer: jobData.buffer,
        filename: jobData.fileName || `recording-${recordingId}.mp3`,
        mimeType: jobData.mimeType || rec.mimeType || "audio/mpeg",
      };
    } else if (jobData.fileUrl && /^https?:\/\//i.test(String(jobData.fileUrl))) {
      const buffer = await downloadTwilioRecording(settings, jobData.fileUrl);
      audio = {
        buffer,
        filename: jobData.fileName || `recording-${recordingId}.mp3`,
        mimeType: jobData.mimeType || rec.mimeType || "audio/mpeg",
      };
    } else {
      let resolvedPath = jobData.filePath;
      if (!resolvedPath && rec.fileUrl) {
        resolvedPath = path.join(uploadDir, path.basename(rec.fileUrl));
      } else if (resolvedPath && !path.isAbsolute(resolvedPath)) {
        resolvedPath = path.join(uploadDir, resolvedPath);
      }

      if (!resolvedPath) {
        throw new Error("No audio file attached to this recording");
      }

      try {
        await fs.access(resolvedPath);
      } catch {
        throw new Error("Audio file is missing on the server");
      }

      audio = {
        filePath: resolvedPath,
        filename: jobData.fileName || path.basename(resolvedPath),
        mimeType: jobData.mimeType || rec.mimeType || "audio/mpeg",
      };
    }

    const transcript = await transcribeAudio(settings, audio);
    let summary = rec.summary || "";
    let summaryAi = rec.summaryAi || false;

    if (settings.aiSummaries && transcript) {
      try {
        const { summarizeTranscript } = await import("./ai.js");
        summary = await summarizeTranscript(settings, {
          transcript,
          title: rec.title,
          contact: rec.contact,
        });
        summaryAi = true;
      } catch (sumErr) {
        console.warn("[transcription-worker] Summarization failed:", sumErr.message);
      }
    }

    const saved = await mutateDb((currentDb) => {
      const item = currentDb.recordings.find((r) => r.id === recordingId);
      if (!item) return null;
      item.transcript = transcript;
      if (summary) {
        item.summary = summary;
        item.summaryAi = summaryAi;
      }
      item.status = "completed";
      item.mediaStatus = "Transcribed";
      item.updatedAt = now();
      return { ...item };
    });

    try {
      broadcast(
        "recording.transcribed",
        {
          recordingId,
          status: "completed",
          mediaStatus: "Transcribed",
          transcript,
          summary: saved?.summary || summary,
          recording: saved,
          timestamp: now(),
        },
        userId,
      );
    } catch (sseErr) {
      console.warn("[transcription-worker] SSE broadcast error:", sseErr.message);
    }

    return {
      recordingId,
      status: "completed",
      transcript,
      summary: saved?.summary || summary,
      recording: saved,
    };
  } catch (error) {
    await mutateDb((currentDb) => {
      const item = currentDb.recordings.find((r) => r.id === recordingId);
      if (item) {
        item.status = "failed";
        item.mediaStatus = "failed";
        item.transcriptionError = error.message;
        item.error = error.message;
        item.updatedAt = now();
      }
    });

    try {
      broadcast(
        "recording.failed",
        {
          recordingId,
          status: "failed",
          mediaStatus: "failed",
          error: error.message,
          timestamp: now(),
        },
        userId,
      );
    } catch (sseErr) {
      console.warn("[transcription-worker] SSE failure broadcast error:", sseErr.message);
    }

    throw error;
  }
}

/**
 * Starts BullMQ transcription worker.
 *
 * @param {object} [options]
 * @param {boolean} [options.forceInMemory=false]
 * @returns {Worker|null}
 */
export function startTranscriptionWorker({ forceInMemory = false } = {}) {
  const connection = getRedisConnection();
  if (!connection || forceInMemory) return null;
  if (worker) return worker;

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      return await processTranscriptionJob(job.data);
    },
    {
      connection,
      concurrency: 2,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[transcription-worker] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

export async function stopTranscriptionWorker() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

export async function closeTranscriptionQueue() {
  await stopTranscriptionWorker();
  if (bullQueue) {
    await bullQueue.close();
    bullQueue = null;
  }
  if (inMemoryQueue) {
    await inMemoryQueue.close();
    inMemoryQueue = null;
  }
}

export function clearTranscriptionQueue() {
  if (inMemoryQueue) {
    inMemoryQueue.clear();
  }
}

export function getInMemoryTranscriptionJobs() {
  return inMemoryQueue ? inMemoryQueue.getJobs() : [];
}

export async function processNextInMemoryJob() {
  const queue = getTranscriptionQueue({ forceInMemory: true });
  const jobs = queue.getJobs();
  if (jobs.length === 0) return null;
  const job = jobs.shift();
  return await processTranscriptionJob(job.data);
}
