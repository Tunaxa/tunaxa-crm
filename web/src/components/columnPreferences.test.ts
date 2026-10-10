import { describe, expect, it } from "vitest";
import { columnPreferenceKey, readHiddenColumns, visibleColumnKeys } from "./columnPreferences";

const columns = [{ key: "name", label: "Name", required: true }, { key: "email", label: "Email" }, { key: "phone", label: "Phone" }];
describe("column preferences", () => {
  it("restores saved choices after recreating the reader, scoped by user and resource", () => {
    const stored = new Map([[columnPreferenceKey("contacts", "alice"), JSON.stringify(["email"])]]);
    const reader = { getItem: (key: string) => stored.get(key) ?? null };
    expect(visibleColumnKeys(columns, readHiddenColumns(reader, columnPreferenceKey("contacts", "alice")))).toEqual(["name", "phone"]);
    expect(readHiddenColumns(reader, columnPreferenceKey("leads", "alice"))).toEqual([]);
    expect(readHiddenColumns(reader, columnPreferenceKey("contacts", "bob"))).toEqual([]);
  });
  it("recovers from invalid or inaccessible browser storage", () => {
    for (const value of ["broken", "{}", '["email", 1]']) expect(readHiddenColumns({ getItem: () => value }, "key")).toEqual([]);
    expect(readHiddenColumns({ getItem: () => { throw new Error("blocked"); } }, "key")).toEqual([]);
  });
  it("keeps identity visible and shows newly introduced columns", () => {
    expect(visibleColumnKeys(columns, ["name", "email", "deleted-field"])).toEqual(["name", "phone"]);
    expect(visibleColumnKeys([...columns, { key: "score", label: "Score" }], ["email"])).toEqual(["name", "phone", "score"]);
    expect(visibleColumnKeys(columns, [])).toEqual(["name", "email", "phone"]);
  });
});
