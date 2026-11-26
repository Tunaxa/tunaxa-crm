import { Worker } from "bullmq";
import { query } from "../db/pg.js";
import { signPayload } from "../services/webhookQueue.js";
import {
  assertSafeWebhookUrl,
  readBoundedResponse,
} from "../services/webhookSecurity.js";

const REDIS_URL =
  process.env.REDIS_URL ||
  (process.env.REDIS_ENABLED === "true" ? "redis://127.0.0.1:6380" : null);
const DELIVERY_TIMEOUT_MS = 10_000;
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
  } catch (error) {
    console.error(`[webhook] Failed to log attempt #${attempt_number}:`, error.message);
  }
}

export async function deliverWebhook(job) {
  const { event_id, url, secret, payload } = job?.data ?? job ?? {};
  const safeUrl = await assertSafeWebhookUrl(url);
  const body = JSON.stringify(payload);
  const signature = signPayload(body, secret);

  let res;
  try {
    res = await fetch(safeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tunaxa-Signature": `sha256=${signature}`,
        "X-Tunaxa-Event": payload?.event,
        "X-Tunaxa-Delivery": event_id,
        "User-Agent": "Tunaxa-Webhook/1.0",
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (error) {
    error.httpStatus = null;
    throw error;
  }

  if (res.status >= 300 && res.status < 400) {
    const error = new Error(`Webhook redirects are not allowed (${res.status})`);
    error.httpStatus = res.status;
    throw error;
  }

  if (!res.ok) {
    const error = new Error(`Webhook returned ${res.status}: ${res.statusText}`);
    error.httpStatus = res.status;
    throw error;
  }

  await readBoundedResponse(res);

  await query(
    `UPDATE webhook_events SET status = 'completed', attempts = attempts + 1, updated_at = NOW() WHERE id = $1`,
    [event_id],
  );

  await logAttempt(
    event_id,
    job?.attemptsMade + 1,
    "success",
    res.status,
    res.statusText || "OK",
  );

  return { status: "delivered", event_id };
}

export function startWebhookWorker() {
  if (!REDIS_URL) return null;
  if (worker) return worker;

  worker = new Worker(
    "webhooks",
    async (job) => deliverWebhook(job),
    {
      connection: { url: REDIS_URL },
      concurrency: 10,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === "tunaxaSchedule") {
            const delay = getRetryDelay(attemptsMade);
            return delay !== null ? delay : -1;
          }
        },
      },
    },
  );

  worker.on("failed", async (job, error) => {
    const event_id = job?.data?.event_id;
    if (event_id) {
      const attemptsMade = job?.attemptsMade ?? 1;
      const delay = getRetryDelay(attemptsMade);

      if (delay === null) {
        await query(
          `UPDATE webhook_events SET status = 'failed', attempts = attempts + 1, last_error = $1, next_retry_at = NULL, updated_at = NOW() WHERE id = $2`,
          [error.message, event_id],
        ).catch(() => {});
      } else {
        await query(
          `UPDATE webhook_events SET status = 'failed', attempts = attempts + 1, last_error = $1, next_retry_at = NOW() + interval '1 millisecond' * $2, updated_at = NOW() WHERE id = $3`,
          [error.message, delay, event_id],
        ).catch(() => {});
      }

      await logAttempt(
        event_id,
        attemptsMade,
        "failed",
        error.httpStatus ?? null,
        error.message,
      );
    }
    console.error(
      `[webhook] Worker failed (attempt ${job?.attemptsMade}):`,
      error.message,
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
