import { describe, expect, it } from "vitest";

import { hashParams } from "../../../services/cache.js";

describe("hashParams", () => {
  it("uses the all key for empty or undefined parameters", () => {
    expect(hashParams()).toBe("all");
    expect(hashParams({})).toBe("all");
    expect(hashParams({ page: undefined })).toBe("all");
  });

  it("sorts keys and ignores undefined values", () => {
    const first = hashParams({
      page: 2,
      q: "acme",
      ignored: undefined,
      nested: { second: 2, first: 1 },
    });
    const second = hashParams({
      nested: { first: 1, second: 2 },
      q: "acme",
      page: 2,
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
  });

  it("distinguishes different parameter values", () => {
    expect(hashParams({ page: 1 })).not.toBe(hashParams({ page: 2 }));
  });
});
