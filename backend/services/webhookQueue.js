import { Queue } from "bullmq";
import crypto from "node:crypto";

const REDIS_URL =
  process.env.REDIS_URL ||
  (process.env.REDIS_ENABLED === "true" ? "redis://127.0.0.1:6380" : null);

let queue = null;

export function getWebhookQueue() {
  if (!REDIS_URL) return null;

  if (!queue) {
    queue = new Queue("webhooks", {
      connection: { url: REDIS_URL },
      defaultJobOptions: {
        // 1 initial attempt + 3 retries. The exact 1/5/30-minute backoff is
        // provided by the worker's `tunaxaSchedule` custom backoff strategy
        // (getRetryDelay); after the 4th total attempt the job stays failed.
        attempts: 4,
        backoff: { type: "tunaxaSchedule" },
        removeOnComplete: { age: 7 * 24 * 3600 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }
  return queue;
}

export function signPayload(payload, secret) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(payload, signature, secret) {
  const expected = signPayload(payload, secret);
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signature, "hex"),
  );
}
