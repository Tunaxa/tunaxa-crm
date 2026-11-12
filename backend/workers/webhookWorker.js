/**
 * Outbound webhook delivery worker (BullMQ).
 *
 * Consumes jobs from the "webhooks" queue and delivers the payload to the
 * endpoint URL with an HMAC-SHA256 signature (X-Tunaxa-Signature) so the
 * receiver can verify authenticity. Database state (webhook_events) is updated
 * exclusively through the Postgres helper in ../db/pg.js.
 *
 * Retry/backoff is driven by the queue's attempts/backoff configuration
 * (see ../services/webhookQueue.js); failures update status, last_error and
 * next_retry_at on the event row.
 */
import { Worker } from "bullmq";
import { query } from "../db/pg.js";
import { signPayload } from "../services/webhookQueue.js";

const REDIS_URL =
  process.env.REDIS_URL ||
  (process.env.REDIS_ENABLED === "true" ? "redis://127.0.0.1:6380" : null);

// Exact retry backoff schedule (delays after each failed attempt):
//   1st retry -> 1 minute, 2nd retry -> 5 minutes, 3rd retry -> 30 minutes.
// After the 3rd retry fails (the 4th total attempt) the event is permanently
// failed and no further retry is scheduled (returns null).
const RETRY_DELAYS = { 1: 60_000, 2: 300_000, 3: 1_800_000 };

export function getRetryDelay(attempts) {
  return RETRY_DELAYS[attempts] ?? null;
}

let worker = null;

async function logAttempt(event_id, attempt_number, status, http_status, message) {
  try {
    await query(
      `INSERT INTO webhook_delivery_attempts (event_id, attempt_number, status, http_status, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [event_id, attempt_number, status, http_status ?? null, message ?? null],
    );
  } catch (err) {
    // Attempt logging is best-effort: never fail the delivery because of it.
    console.error(`[webhook] Failed to log attempt #${attempt_number}:`, err.message);
  }
}

export function startWebhookWorker() {
  if (!REDIS_URL) return null;
  if (worker) return worker;

  worker = new Worker(
    "webhooks",
    async (job) => {
      const { event_id, url, secret, payload } = job.data;

      const body = JSON.stringify(payload);
      const signature = signPayload(body, secret);

      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Tunaxa-Signature": `sha256=${signature}`,
            "X-Tunaxa-Event": payload.event,
            "X-Tunaxa-Delivery": event_id,
            "User-Agent": "Tunaxa-Webhook/1.0",
          },
          body,
          signal: AbortSignal.timeout(10000),
        });
      } catch (err) {
        err.httpStatus = null;
        throw err;
      }

      if (!res.ok) {
        const error = new Error(
          `Webhook returned ${res.status}: ${res.statusText}`,
        );
        error.httpStatus = res.status;
        throw error;
      }

      await query(
        `UPDATE webhook_events SET status = 'completed', attempts = attempts + 1, updated_at = NOW() WHERE id = $1`,
        [event_id],
      );

      await logAttempt(
        event_id,
        job.attemptsMade + 1,
        "success",
        res.status,
        res.statusText || "OK",
      );

      return { status: "delivered", event_id };
    },
    {
      connection: { url: REDIS_URL },
      concurrency: 10,
      // BullMQ v6 reads a single custom backoff function from
      // `settings.backoffStrategy`. The former `worker.backoffStrategies`
      // property is ignored, which made the tunaxaSchedule type unresolvable.
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === "tunaxaSchedule") {
            const delay = getRetryDelay(attemptsMade);
            return delay !== null ? delay : -1; // -1 means do not retry
          }
        },
      },
    },
  );

  worker.on("failed", async (job, err) => {
    const event_id = job?.data?.event_id;
    if (event_id) {
      const attemptsMade = job?.attemptsMade ?? 1;
      const delay = getRetryDelay(attemptsMade);

      if (delay === null) {
        // 4th total attempt: all 3 retries exhausted -> permanently failed.
        await query(
          `UPDATE webhook_events SET status = 'failed', attempts = attempts + 1, last_error = $1, next_retry_at = NULL, updated_at = NOW() WHERE id = $2`,
          [err.message, event_id],
        ).catch(() => {});
      } else {
        await query(
          `UPDATE webhook_events SET status = 'failed', attempts = attempts + 1, last_error = $1, next_retry_at = NOW() + interval '1 millisecond' * $2, updated_at = NOW() WHERE id = $3`,
          [err.message, delay, event_id],
        ).catch(() => {});
      }

      await logAttempt(event_id, attemptsMade, "failed", err.httpStatus ?? null, err.message);
    }
    console.error(
      `[webhook] Worker failed (attempt ${job?.attemptsMade}):`,
      err.message,
    );
  });

  worker.on("completed", (job) => {
    console.log(
      `[webhook] Delivered: ${job.data.payload?.event} -> ${job.data.url}`,
    );
  });

  console.log("[webhook] Worker started (Redis:", REDIS_URL, ")");
  return worker;
}

export async function stopWebhookWorker() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}