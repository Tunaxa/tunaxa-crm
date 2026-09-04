import { Worker } from "bullmq";
import crypto from "node:crypto";
import { query } from "../db/pg.js";

const REDIS_URL =
  process.env.REDIS_URL ||
  (process.env.REDIS_ENABLED === "true" ? "redis://127.0.0.1:6380" : null);

let worker = null;

export function startWebhookWorker() {
  if (!REDIS_URL) return null;
  if (worker) return worker;

  worker = new Worker(
    "webhooks",
    async (job) => {
      const { event_id, url, secret, payload } = job.data;

      const body = JSON.stringify(payload);
      const signature = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex");

      const res = await fetch(url, {
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

      if (!res.ok) {
        throw new Error(`Webhook returned ${res.status}: ${res.statusText}`);
      }

      await query(
        `UPDATE webhook_events SET status = 'completed', attempts = attempts + 1, updated_at = NOW() WHERE id = $1`,
        [event_id],
      );

      return { status: "delivered", event_id };
    },
    {
      connection: { url: REDIS_URL },
      concurrency: 10,
    },
  );

  worker.on("failed", async (job, err) => {
    const event_id = job?.data?.event_id;
    if (event_id) {
      const delay = getRetryDelay(job.attemptsMade);
      await query(
        `UPDATE webhook_events SET status = 'failed', attempts = attempts + 1, last_error = $1, next_retry_at = NOW() + interval '1 millisecond' * $2, updated_at = NOW() WHERE id = $3`,
        [err.message, delay, event_id],
      ).catch(() => {});
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

function getRetryDelay(attempts) {
  const delays = [10000, 60000, 300000, 1800000, 7200000];
  return delays[Math.min(attempts, delays.length - 1)];
}

export async function stopWebhookWorker() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
