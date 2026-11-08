import { describe, it, expect } from "vitest";
import { getRetryDelay } from "../workers/webhookWorker.js";

describe("Webhook worker retry backoff schedule", () => {
  it("waits exactly 1 minute before the 1st retry", () => {
    expect(getRetryDelay(1)).toBe(60_000);
  });

  it("waits exactly 5 minutes before the 2nd retry", () => {
    expect(getRetryDelay(2)).toBe(300_000);
  });

  it("waits exactly 30 minutes before the 3rd retry", () => {
    expect(getRetryDelay(3)).toBe(1_800_000);
  });

  it("permanently fails the event after the 4th total attempt (no more retries)", () => {
    expect(getRetryDelay(4)).toBeNull();
    expect(getRetryDelay(5)).toBeNull();
  });
});