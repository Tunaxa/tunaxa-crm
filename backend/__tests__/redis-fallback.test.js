import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getWebhookQueue } from "../services/webhookQueue.js";
import { startWebhookWorker } from "../workers/webhookWorker.js";

describe("Redis fallback behavior", () => {
  const originalRedisUrl = process.env.REDIS_URL;
  const originalRedisEnabled = process.env.REDIS_ENABLED;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_ENABLED;
  });

  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;

    if (originalRedisEnabled === undefined) delete process.env.REDIS_ENABLED;
    else process.env.REDIS_ENABLED = originalRedisEnabled;
  });

  it("disables the queue and worker when Redis is not configured", () => {
    expect(getWebhookQueue()).toBeNull();
    expect(startWebhookWorker()).toBeNull();
  });
});
