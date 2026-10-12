import { describe, expect, it } from "vitest";
import { defaultWinner, duplicateFields, mergeOverrides } from "./DuplicateResolution";

describe("duplicate value choices", () => {
  const primary = { id: "a", name: "Alice", phone: "", value: 0, active: false, createdAt: "old" };
  const secondary = { id: "b", name: "Alicia", phone: "123", value: 99, active: true, email: "a@example.com", workspace_id: "server" };
  it("excludes identity and server-owned fields", () => {
    expect(duplicateFields(primary, secondary)).not.toContain("id");
    expect(duplicateFields(primary, secondary)).not.toContain("createdAt");
    expect(duplicateFields(primary, secondary)).not.toContain("workspace_id");
  });
  it("fills missing values while preserving zero and false", () => {
    expect(defaultWinner(primary, secondary, "phone")).toBe("secondary");
    expect(mergeOverrides(primary, secondary, {})).toEqual({ name: "Alice", phone: "123", value: 0, active: false, email: "a@example.com" });
  });
  it("honors explicit winners, including an intentional blank", () => {
    expect(mergeOverrides(primary, secondary, { name: "secondary", phone: "primary" })).toMatchObject({ name: "Alicia", phone: "" });
  });
});
