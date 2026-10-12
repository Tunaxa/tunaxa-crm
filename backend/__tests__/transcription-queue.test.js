import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import supertest from 'supertest';
import { app } from '../server.js';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import { mutateDb, readDb } from '../store.js';
import { id, now } from '../helpers.js';
import * as ai from '../services/ai.js';
import * as sse from '../routes/sse.js';
import * as twilio from '../services/twilio.js';
import {
  QUEUE_NAME,
  getRedisConnection,
  getTranscriptionQueue,
  queueTranscriptionJob,
  processTranscriptionJob,
  processNextInMemoryJob,
  startTranscriptionWorker,
  stopTranscriptionWorker,
  closeTranscriptionQueue,
  clearTranscriptionQueue,
  getInMemoryTranscriptionJobs,
} from '../services/transcriptionQueue.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const testUploadDir = path.join(root, '..', 'uploads');
let token = null;

beforeAll(async () => {
  await resetTestDb();
  await seedTestUser();
  token = await loginAs(app);
  await fs.mkdir(testUploadDir, { recursive: true });
}, 30000);

afterAll(async () => {
  await closeTranscriptionQueue();
  await cleanupTestDb();
});

beforeEach(async () => {
  clearTranscriptionQueue();
  vi.restoreAllMocks();
  vi.spyOn(ai, 'summarizeTranscript').mockResolvedValue('Mocked summary');

  // Ensure AI is configured in settings
  await mutateDb((db) => {
    db.settings = {
      ...db.settings,
      ollamaHost: 'http://localhost:11434',
      ollamaTranscriptionModel: 'whisper',
      aiSummaries: true,
    };
  });
});

describe('Async Transcription Queue via BullMQ', () => {
  describe('1. Queue Management & Fallback', () => {
    it('initializes in-memory queue fallback when Redis is unavailable', () => {
      const queue = getTranscriptionQueue({ forceInMemory: true });
      expect(queue).toBeDefined();
      expect(queue.name).toBe(QUEUE_NAME);
      expect(queue.jobs).toEqual([]);
    });

    it('adds and clears jobs from in-memory queue', async () => {
      const job = await queueTranscriptionJob({
        recordingId: 'rec_test_1',
        fileName: 'test.mp3',
      }, { forceInMemory: true });

      expect(job.id).toBeDefined();
      expect(job.recordingId).toBe('rec_test_1');

      const jobs = getInMemoryTranscriptionJobs();
      expect(jobs.length).toBe(1);
      expect(jobs[0].data.recordingId).toBe('rec_test_1');

      clearTranscriptionQueue();
      expect(getInMemoryTranscriptionJobs().length).toBe(0);
    });

    it('getRedisConnection returns null when no REDIS env vars exist', () => {
      const origUrl = process.env.REDIS_URL;
      const origHost = process.env.REDIS_HOST;
      const origPort = process.env.REDIS_PORT;
      const origEnabled = process.env.REDIS_ENABLED;

      delete process.env.REDIS_URL;
      delete process.env.REDIS_HOST;
      delete process.env.REDIS_PORT;
      delete process.env.REDIS_ENABLED;

      expect(getRedisConnection()).toBeNull();

      if (origUrl) process.env.REDIS_URL = origUrl;
      if (origHost) process.env.REDIS_HOST = origHost;
      if (origPort) process.env.REDIS_PORT = origPort;
      if (origEnabled) process.env.REDIS_ENABLED = origEnabled;
    });
  });

  describe('2. Immediate HTTP Response on Upload Flow', () => {
    it('saves recording with status: "queued", enqueues job, and immediately returns 201', async () => {
      const sampleAudio = Buffer.from('RIFF....WAVEfmt ....data....');

      const res = await supertest(app)
        .post('/api/recordings/upload')
        .set('Authorization', `Bearer ${token}`)
        .field('title', 'Sales Demo Recording')
        .field('contact', 'Alice Smith')
        .attach('audio', sampleAudio, 'demo-call.mp3');

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.title).toBe('Sales Demo Recording');
      expect(res.body.contact).toBe('Alice Smith');
      expect(res.body.status).toBe('queued');
      expect(res.body.mediaStatus).toBe('queued');
      expect(res.body.jobId).toBeDefined();

      // Check DB record
      const db = await readDb();
      const savedRec = db.recordings.find((r) => r.id === res.body.id);
      expect(savedRec).toBeDefined();
      expect(savedRec.status).toBe('queued');
      expect(savedRec.mediaStatus).toBe('queued');

      // Check that a transcription job was enqueued
      const jobs = getInMemoryTranscriptionJobs();
      const queuedJob = jobs.find((j) => j.data.recordingId === res.body.id);
      expect(queuedJob).toBeDefined();
      expect(queuedJob.data.fileName).toBe('demo-call.mp3');
    });
  });

  describe('3. Worker Processing & SSE Broadcast', () => {
    it('worker executes transcription, persists transcript, updates status to completed, and broadcasts SSE', async () => {
      // 1. Create a dummy test audio file in testUploadDir
      const dummyFilename = `test-${Date.now()}.mp3`;
      const dummyFilePath = path.join(testUploadDir, dummyFilename);
      await fs.writeFile(dummyFilePath, 'dummy audio content');

      // 2. Insert a recording in queued state
      const recordingId = id('recording');
      await mutateDb((db) => {
        db.recordings.unshift({
          id: recordingId,
          title: 'Weekly Sync',
          contact: 'Bob Builder',
          duration: '3:45',
          transcript: '',
          summary: '',
          fileUrl: `/uploads/${dummyFilename}`,
          originalName: dummyFilename,
          mimeType: 'audio/mpeg',
          status: 'queued',
          mediaStatus: 'queued',
          createdAt: now(),
          updatedAt: now(),
        });
      });

      // 3. Spy on transcribeAudio and broadcast
      const expectedTranscript = 'Good morning everyone, lets review the quarterly CRM sales projections.';
      const expectedSummary = 'Quarterly CRM sales review with customer signals and next steps.';

      const transcribeSpy = vi.spyOn(ai, 'transcribeAudio').mockResolvedValue(expectedTranscript);
      const summarizeSpy = vi.spyOn(ai, 'summarizeTranscript').mockResolvedValue(expectedSummary);
      const broadcastSpy = vi.spyOn(sse, 'broadcast').mockImplementation(() => {});

      // 4. Process the transcription job
      const result = await processTranscriptionJob({
        recordingId,
        filePath: dummyFilePath,
        fileName: dummyFilename,
        mimeType: 'audio/mpeg',
        workspaceId: 'default',
        userId: 'usr_test',
      });

      expect(result.status).toBe('completed');
      expect(result.transcript).toBe(expectedTranscript);
      expect(transcribeSpy).toHaveBeenCalledTimes(1);

      // 5. Verify recording record in DB
      const db = await readDb();
      const updatedRec = db.recordings.find((r) => r.id === recordingId);
      expect(updatedRec.status).toBe('completed');
      expect(updatedRec.mediaStatus).toBe('Transcribed');
      expect(updatedRec.transcript).toBe(expectedTranscript);
      expect(updatedRec.summary).toBe(expectedSummary);
      expect(updatedRec.summaryAi).toBe(true);

      // 6. Verify SSE broadcast
      expect(broadcastSpy).toHaveBeenCalledWith(
        'recording.transcribed',
        expect.objectContaining({
          recordingId,
          status: 'completed',
          mediaStatus: 'Transcribed',
          transcript: expectedTranscript,
          summary: expectedSummary,
        }),
        'usr_test',
      );

      // Clean up test file
      await fs.unlink(dummyFilePath).catch(() => {});
    });

    it('processes queued jobs via processNextInMemoryJob helper', async () => {
      const dummyFilename = `test-helper-${Date.now()}.mp3`;
      const dummyFilePath = path.join(testUploadDir, dummyFilename);
      await fs.writeFile(dummyFilePath, 'audio data');

      const recordingId = id('recording');
      await mutateDb((db) => {
        db.recordings.unshift({
          id: recordingId,
          title: 'Helper Queue Test',
          fileUrl: `/uploads/${dummyFilename}`,
          status: 'queued',
          mediaStatus: 'queued',
          createdAt: now(),
          updatedAt: now(),
        });
      });

      await queueTranscriptionJob({
        recordingId,
        filePath: dummyFilePath,
      }, { forceInMemory: true });

      vi.spyOn(ai, 'transcribeAudio').mockResolvedValue('Helper transcript');
      vi.spyOn(sse, 'broadcast').mockImplementation(() => {});

      const processed = await processNextInMemoryJob();
      expect(processed).toBeDefined();
      expect(processed.recordingId).toBe(recordingId);
      expect(processed.status).toBe('completed');
      expect(processed.transcript).toBe('Helper transcript');

      await fs.unlink(dummyFilePath).catch(() => {});
    });
  });

  describe('4. Worker Failure Handling & Error SSE', () => {
    it('sets status to failed, records error, and broadcasts recording.failed on transcription failure', async () => {
      const dummyFilename = `fail-${Date.now()}.mp3`;
      const dummyFilePath = path.join(testUploadDir, dummyFilename);
      await fs.writeFile(dummyFilePath, 'dummy audio content');

      const recordingId = id('recording');
      await mutateDb((db) => {
        db.recordings.unshift({
          id: recordingId,
          title: 'Failing Recording',
          fileUrl: `/uploads/${dummyFilename}`,
          status: 'queued',
          mediaStatus: 'queued',
          createdAt: now(),
          updatedAt: now(),
        });
      });

      const errorMessage = 'Ollama transcription connection timed out';
      vi.spyOn(ai, 'transcribeAudio').mockRejectedValue(new Error(errorMessage));
      const broadcastSpy = vi.spyOn(sse, 'broadcast').mockImplementation(() => {});

      await expect(
        processTranscriptionJob({
          recordingId,
          filePath: dummyFilePath,
          userId: 'usr_test',
        }),
      ).rejects.toThrow(errorMessage);

      // Verify DB record has failed status and error message
      const db = await readDb();
      const failedRec = db.recordings.find((r) => r.id === recordingId);
      expect(failedRec.status).toBe('failed');
      expect(failedRec.mediaStatus).toBe('failed');
      expect(failedRec.transcriptionError).toBe(errorMessage);

      // Verify SSE broadcast for failure
      expect(broadcastSpy).toHaveBeenCalledWith(
        'recording.failed',
        expect.objectContaining({
          recordingId,
          status: 'failed',
          mediaStatus: 'failed',
          error: errorMessage,
        }),
        'usr_test',
      );

      await fs.unlink(dummyFilePath).catch(() => {});
    });

    it('fails gracefully when recording is not found in database', async () => {
      await expect(
        processTranscriptionJob({
          recordingId: 'rec_non_existent',
        }),
      ).rejects.toThrow('Recording rec_non_existent not found');
    });

    it('fails gracefully when audio file is missing on disk', async () => {
      const recordingId = id('recording');
      await mutateDb((db) => {
        db.recordings.unshift({
          id: recordingId,
          title: 'Missing File',
          fileUrl: '/uploads/missing-file.mp3',
          status: 'queued',
          createdAt: now(),
        });
      });

      await expect(
        processTranscriptionJob({
          recordingId,
          filePath: path.join(testUploadDir, 'missing-file.mp3'),
        }),
      ).rejects.toThrow('Audio file is missing on the server');
    });
  });

  describe('5. Asynchronous Transcribe Route Mode (?async=true)', () => {
    it('returns 202 Accepted and queues job when POST /api/recordings/:id/transcribe?async=true', async () => {
      const dummyFilename = `async-route-${Date.now()}.mp3`;
      const dummyFilePath = path.join(testUploadDir, dummyFilename);
      await fs.writeFile(dummyFilePath, 'dummy');

      const recordingId = id('recording');
      await mutateDb((db) => {
        db.recordings.unshift({
          id: recordingId,
          title: 'Async Route Test',
          fileUrl: `/uploads/${dummyFilename}`,
          status: 'ready',
          mediaStatus: 'Audio ready',
          createdAt: now(),
        });
      });

      const res = await supertest(app)
        .post(`/api/recordings/${recordingId}/transcribe?async=true`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(202);
      expect(res.body.message).toBe('Transcription job enqueued');
      expect(res.body.status).toBe('queued');
      expect(res.body.jobId).toBeDefined();

      const jobs = getInMemoryTranscriptionJobs();
      expect(jobs.some((j) => j.data.recordingId === recordingId)).toBe(true);

      await fs.unlink(dummyFilePath).catch(() => {});
    });
  });

  describe('6. Twilio Remote Audio Transcription Support', () => {
    it('downloads remote Twilio recording buffer and processes transcription', async () => {
      const recordingId = id('recording');
      const twilioUrl = 'https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE123.mp3';

      await mutateDb((db) => {
        db.recordings.unshift({
          id: recordingId,
          title: 'Twilio Inbound Call',
          fileUrl: twilioUrl,
          status: 'queued',
          mediaStatus: 'queued',
          createdAt: now(),
        });
      });

      const fakeBuffer = Buffer.from('fake twilio audio');
      const downloadSpy = vi.spyOn(twilio, 'downloadTwilioRecording').mockResolvedValue(fakeBuffer);
      const transcribeSpy = vi.spyOn(ai, 'transcribeAudio').mockResolvedValue('Twilio transcription text');
      vi.spyOn(sse, 'broadcast').mockImplementation(() => {});

      const result = await processTranscriptionJob({
        recordingId,
        fileUrl: twilioUrl,
      });

      expect(downloadSpy).toHaveBeenCalledWith(expect.anything(), twilioUrl);
      expect(transcribeSpy).toHaveBeenCalledTimes(1);
      expect(result.transcript).toBe('Twilio transcription text');

      const db = await readDb();
      const updated = db.recordings.find((r) => r.id === recordingId);
      expect(updated.status).toBe('completed');
      expect(updated.mediaStatus).toBe('Transcribed');
      expect(updated.transcript).toBe('Twilio transcription text');
    });
  });
});
