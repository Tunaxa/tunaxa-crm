import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheIncr = vi.fn();

vi.mock("./cache.js", () => ({ cacheIncr }));

const { createRateLimiter } = await import("./rateLimit.js");

function response() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe("rate limiter", () => {
  beforeEach(() => {
    cacheIncr.mockReset();
  });

  it("uses Redis counts when the cache is available", async () => {
    cacheIncr.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, prefix: "redis-test" });
    const req = { ip: "127.0.0.10" };
    const first = response();
    const second = response();
    let nextCount = 0;

    await limiter(req, first, () => { nextCount += 1; });
    await limiter(req, second, () => { nextCount += 1; });

    expect(nextCount).toBe(1);
    expect(second.statusCode).toBe(429);
    expect(second.headers["Retry-After"]).toBe(60);
    expect(cacheIncr).toHaveBeenNthCalledWith(1, "rate-limit:redis-test:127.0.0.10", 60);
  });

  it("falls back to the in-memory bucket when Redis is unavailable", async () => {
    cacheIncr.mockResolvedValue(null);
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, prefix: "memory-test" });
    const req = { ip: "127.0.0.11" };
    const first = response();
    const second = response();
    let nextCount = 0;

    await limiter(req, first, () => { nextCount += 1; });
    await limiter(req, second, () => { nextCount += 1; });

    expect(nextCount).toBe(1);
    expect(second.statusCode).toBe(429);
  });
});
