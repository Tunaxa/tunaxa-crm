import { describe, expect, it } from "vitest";
import { buildFilter, filterOperators } from "./FilterBuilder";

const fields = [{ key: "company", label: "Company" }, { key: "score", label: "Score", type: "number" }, { key: "active", label: "Active", type: "checkbox" }];
describe("advanced filter payload", () => {
  it("builds three typed conditions with AND and OR", () => {
    const rows = [{ id: 1, field: "company", operator: "contains", value: "Acme" }, { id: 2, field: "score", operator: "gt", value: "0" }, { id: 3, field: "active", operator: "eq", value: "false" }];
    const conditions = [{ field: "company", operator: "contains", value: "Acme" }, { field: "score", operator: "gt", value: 0 }, { field: "active", operator: "eq", value: false }];
    expect(buildFilter(rows, fields, "AND")).toEqual({ $and: conditions });
    expect(buildFilter(rows, fields, "OR")).toEqual({ $or: conditions });
  });
  it("omits values for presence checks and clears empty groups", () => {
    expect(buildFilter([{ id: 1, field: "company", operator: "is_set", value: "" }], fields, "AND")).toEqual({ $and: [{ field: "company", operator: "is_set" }] });
    expect(buildFilter([], fields, "AND")).toBeNull();
  });
  it("rejects invalid fields, incompatible operators and blank or invalid values", () => {
    for (const row of [{ field: "missing", operator: "eq", value: "x" }, { field: "active", operator: "contains", value: "x" }, { field: "score", operator: "eq", value: " " }, { field: "score", operator: "eq", value: "abc" }]) {
      expect(() => buildFilter([{ id: 1, ...row }], fields, "AND")).toThrow();
    }
    expect(filterOperators("number")).not.toContain("contains");
  });
});
