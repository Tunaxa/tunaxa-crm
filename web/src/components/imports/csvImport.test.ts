import { describe, expect, it, vi } from "vitest";
import { detectDelimiter, errorReportCsv, guessMapping, importFields, mappingErrors, MAX_CSV_ROWS, parseCsv, prepareRows, runCsvImport } from "./csvImport";
import type { FieldSpec } from "../records/types";

const fields: FieldSpec[] = [
  { key: "name", label: "Contact name", required: true }, { key: "email", label: "Email", type: "email" },
  { key: "value", label: "Value", type: "number" }, { key: "active", label: "Active", type: "checkbox" },
  { key: "date", label: "Date", type: "date" }, { key: "status", label: "Status", type: "select", options: ["New", "Nurture"] },
];
const rows = () => prepareRows(parseCsv("name,email\nAlex,alex@example.test\nSam,sam@example.test\nTaylor,taylor@example.test"), ["name", "email"], fields);

describe("CSV parsing", () => {
  it("preserves quoted commas, escaped quotes, blank lines and multiline values with original line numbers", () => {
    const csv = parseCsv('\uFEFFname,notes\r\n"A, B","Said ""hello""\r\nNext line"\r\n\r\nSam,end\r\n');
    expect(csv.headers).toEqual(["name", "notes"]);
    expect(csv.rows).toEqual([{ rowNumber: 2, values: ["A, B", 'Said "hello"\nNext line'], error: undefined },
      { rowNumber: 5, values: ["Sam", "end"], error: undefined }]);
  });
  it.each([";", "\t"])("detects and reads %j separators without counting quoted punctuation", delimiter => {
    const text = `name${delimiter}"notes, with commas"\nAlex${delimiter}hello`;
    expect(detectDelimiter(text)).toBe(delimiter);
    expect(parseCsv(text, delimiter).rows[0].values).toEqual(["Alex", "hello"]);
  });
  it("keeps ragged rows for the error report instead of silently dropping them", () => {
    const csv = parseCsv("name,email\nAlex\nSam,sam@example.test,extra");
    expect(csv.rows.map(row => row.error)).toEqual(["Expected 2 columns; found 1", "Expected 2 columns; found 3"]);
  });
  it.each(['name,email\n"Alex,alex@example.test', 'name\nAle"x', 'name\n"Alex"oops', "name,\nAlex,x", "name,email\n", "name\n\0Alex"])(
    "rejects malformed or empty CSV (%j)", text => expect(() => parseCsv(text)).toThrow());
  it("accepts the maximum row count and rejects oversized CSV", () => {
    expect(parseCsv("name\n" + Array.from({ length: MAX_CSV_ROWS }, (_, index) => `Name ${index}`).join("\n")).rows).toHaveLength(MAX_CSV_ROWS);
    expect(() => parseCsv("name\n" + "Alex\n".repeat(MAX_CSV_ROWS + 1))).toThrow("Maximum 1000");
  });
  it("allows duplicate header labels and maps by column position", () => {
    const csv = parseCsv("name,name\nAlex,ignored");
    expect(prepareRows(csv, ["name", ""], fields)[0].payload).toEqual({ name: "Alex" });
  });
});

describe("CSV column mapping and validation", () => {
  it("suggests aliases without assigning a property twice", () => {
    expect(guessMapping(["Full name", "Email address", "E-mail", "Ignore me"], fields)).toEqual(["name", "email", "", ""]);
  });
  it("requires identities and prevents mapping IDs or workspace metadata", () => {
    const available = importFields("companies", [{ key: "name", label: "Name" }, { key: "id", label: "ID" }, { key: "workspace_id", label: "Workspace" }]);
    expect(available).toEqual([{ key: "name", label: "Name", required: true }]);
    expect(mappingErrors([""], available)).toContain("Map the required property: Name");
    expect(mappingErrors(["name", "name"], available)).toContain("Each destination property can be mapped only once");
    expect(mappingErrors(["id"], available)).toContain("Mapping contains an unavailable property");
  });
  it("requires a deal title and keeps configured custom properties", () => {
    expect(importFields("deals", [{ key: "title", label: "Deal" }, { key: "customScore", label: "Score", type: "number" }])).toEqual([
      { key: "title", label: "Deal", required: true }, { key: "customScore", label: "Score", type: "number", required: undefined }]);
  });
  it("coerces numbers, booleans, dates and enum case without supplying absent values", () => {
    const csv = parseCsv("name,email,value,active,date,status,skip\nAlex,,12.5,YES,2026-02-28,nurture,discard");
    const result = prepareRows(csv, ["name", "email", "value", "active", "date", "status", ""], fields)[0];
    expect(result.errors).toEqual([]);
    expect(result.payload).toEqual({ name: "Alex", value: 12.5, active: true, date: "2026-02-28", status: "Nurture" });
  });
  it("reports required, numeric, email, date and enum errors per row", () => {
    const result = prepareRows(parseCsv("name,email,value,active,date,status\n,bad,Infinity,maybe,2026-02-30,wrong"), fields.map(field => field.key), fields)[0];
    expect(result.errors).toHaveLength(6);
    expect(result.errors.join(" ")).toContain("Contact name is required");
  });
  it("rejects thousands formatting rather than silently changing a numeric value", () => {
    const result = prepareRows(parseCsv('name,value\nAlex,"1,500"'), ["name", "value"], fields)[0];
    expect(result.errors[0]).toContain("valid number");
  });
});

describe("CSV import outcome tracking", () => {
  it("submits valid rows once in order, excludes invalid rows and reports progress", async () => {
    const prepared = rows(); prepared[1].errors = ["Invalid row"];
    let active = 0;
    const create = vi.fn(async (_payload: Record<string, unknown>) => { active++; expect(active).toBe(1); await Promise.resolve(); active--; return { id: `record-${create.mock.calls.length}` }; });
    const progress = vi.fn();
    const results = await runCsvImport(prepared, create, progress);
    expect(create.mock.calls.map(call => call[0])).toEqual([prepared[0].payload, prepared[2].payload]);
    expect(results.map(row => row.status)).toEqual(["imported", "invalid", "imported"]);
    expect(progress).toHaveBeenLastCalledWith(results);
  });
  it("continues after a row rejection while keeping its original CSV line", async () => {
    const create = vi.fn().mockResolvedValueOnce({ id: "one" }).mockRejectedValueOnce(Object.assign(new Error("Email already exists"), { status: 409 })).mockResolvedValueOnce({ id: "three" });
    const results = await runCsvImport(rows(), create);
    expect(results.map(row => row.status)).toEqual(["imported", "failed", "imported"]);
    expect(results[1]).toMatchObject({ rowNumber: 3, reason: "Email already exists" });
  });
  it.each([undefined, 408, 500])("stops on an uncertain response (%s) without retrying or counting it saved", async status => {
    const create = vi.fn().mockResolvedValueOnce({ id: "one" }).mockRejectedValueOnce(Object.assign(new Error("Connection lost"), { status }));
    const results = await runCsvImport(rows(), create);
    expect(create).toHaveBeenCalledTimes(2);
    expect(results.map(row => row.status)).toEqual(["imported", "unconfirmed", "not-imported"]);
  });
  it.each([null, {}, { id: "" }, { id: 123 }])("requires a confirmed record ID (%j)", async response => {
    const create = vi.fn().mockResolvedValue(response);
    expect((await runCsvImport(rows(), create))[0].status).toBe("unconfirmed");
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("does not count a repeated record ID as another created record", async () => {
    const create = vi.fn().mockResolvedValue({ id: "same" });
    expect((await runCsvImport(rows(), create)).map(row => row.status)).toEqual(["imported", "unconfirmed", "not-imported"]);
  });
  it.each([401, 403, 404, 429])("stops after an access or endpoint error (%s)", async status => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("Rejected"), { status }));
    expect((await runCsvImport(rows(), create)).map(row => row.status)).toEqual(["failed", "not-imported", "not-imported"]);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("waits for the current save before honoring a stop request", async () => {
    let stop = false;
    const create = vi.fn(async () => { stop = true; return { id: "confirmed" }; });
    const result = await runCsvImport(rows(), create, () => {}, () => stop);
    expect(result.map(row => row.status)).toEqual(["imported", "not-imported", "not-imported"]);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("exports failed rows only, quoting multiline text and preventing spreadsheet formulas", () => {
    const report = errorReportCsv(["name"], [
      { rowNumber: 2, values: ["Already saved"], status: "imported", id: "one", reason: "" },
      { rowNumber: 3, values: ['=SUM(1,2)'], status: "failed", reason: 'Bad "value"\nRetry later' },
    ]);
    expect(report).not.toContain("Already saved");
    expect(report).toContain("'=" );
    expect(report).toContain('Bad ""value""\nRetry later');
    expect(parseCsv(report).rows[0].values[0]).toBe("3");
  });
  it("preserves unexpected extra values when exporting a malformed row", () => {
    const report = parseCsv(errorReportCsv(["name"], [
      { rowNumber: 2, values: ["Alex", "Unexpected extra data"], status: "invalid", reason: "Expected 1 columns; found 2" },
    ]));
    expect(report.headers).toContain("Extra column 2");
    expect(report.rows[0].values[report.rows[0].values.length - 1]).toBe("Unexpected extra data");
  });
});
