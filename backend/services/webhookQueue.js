/**
 * BullMQ queue wrapper for outbound webhook deliveries.
 *
 * Centralizes queue creation (guarded on Redis availability) and the shared
 * HMAC-SHA256 signing/verification primitives used by both the enqueue path
 * and the delivery worker. No direct file-system access — job state lives in
 * Redis when enabled, and webhook_events state in Postgres via ../db/pg.js.
 */
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
        attempts: 5,
        backoff: { type: "exponential", delay: 10000 },
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
