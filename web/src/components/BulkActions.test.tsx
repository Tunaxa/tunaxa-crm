import { describe, expect, it } from "vitest";
import { failedBatchIds } from "./BulkActions";

describe("bulk result handling", () => {
  it("retains only failures for a partial success", () => {
    expect(failedBatchIds({ successCount: 1, errorCount: 1, errors: [{ id: "b", reason: "Not found" }] }, ["a", "b"])).toEqual(["b"]);
  });
  it("clears all selections on complete success", () => {
    expect(failedBatchIds({ successCount: 2, errorCount: 0, errors: [] }, ["a", "b"])).toEqual([]);
  });
  it("rejects inconsistent counts and unrelated failed ids", () => {
    expect(() => failedBatchIds({ successCount: 0, errorCount: 0, errors: [] }, ["a"])).toThrow();
    expect(() => failedBatchIds({ successCount: 0, errorCount: 1, errors: [{ id: "other", reason: "Missing" }] }, ["a"])).toThrow();
  });
});
