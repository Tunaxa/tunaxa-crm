import { describe, expect, it } from "vitest";
import { filterRestrictedColumns } from "../columnPreferences";
import { isActivationKey } from "./keyboard";
import { canManageRecords } from "./rbac";
import { parseSchemaResponse } from "./useSchema";
import {
  isSafeMediaUrl,
  isSafeRedirectUrl,
  safeMediaSrc,
  sanitizeCsvRecords,
  sanitizeFieldKey,
  sanitizeFormFieldKey,
  sanitizeFormValues,
} from "./urlSecurity";
import type { FieldSpec } from "./types";

describe("schema-driven record fields", () => {
  it("keeps safe custom fields and removes hidden, masked and prototype keys", () => {
    const parsed = parseSchemaResponse({
      customFields: [
        { key: "plan", label: "Plan", type: "currency" },
        { key: "secret", label: "Secret", hidden: true },
        { key: "token", label: "Token", masked: true },
        { key: "__proto__", label: "Unsafe" },
        { name: "channel", label: "Channel", type: "dropdown", options: [{ value: "Web" }, { label: "Phone" }] },
      ],
      hiddenFields: ["internalNotes"],
      maskedFields: [{ name: "ssn" }],
    });

    expect(parsed.fields.map((field) => field.key)).toEqual(["plan", "channel"]);
    expect(parsed.fields[0].type).toBe("number");
    expect(parsed.fields[1].options).toEqual(["Web", "Phone"]);
    expect(parsed.hiddenFields).toContain("internalNotes");
    expect(parsed.maskedFields).toContain("ssn");
  });

  it("filters restricted columns from the column picker", () => {
    const columns = [
      { key: "name", label: "Name" },
      { key: "ssn", label: "SSN" },
      { key: "owner", label: "Owner" },
    ];
    expect(filterRestrictedColumns(columns, { maskedFields: ["ssn"] })).toEqual([
      columns[0],
      columns[2],
    ]);
  });
});

describe("safe URL and key handling", () => {
  it("allows only same-origin or HTTPS redirects and safe image sources", () => {
    expect(isSafeRedirectUrl("/dashboard")).toBe(true);
    expect(isSafeRedirectUrl("https://example.com/thanks")).toBe(true);
    expect(isSafeRedirectUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeRedirectUrl("//evil.example")).toBe(false);
    expect(isSafeRedirectUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isSafeMediaUrl("data:image/png;base64,iVBORw==")).toBe(true);
    expect(isSafeMediaUrl("javascript:alert(1)")).toBe(false);
    expect(safeMediaSrc("java\nscript:alert(1)")).toBe("");
  });

  it("rejects prototype-polluting field keys", () => {
    for (const key of ["__proto__", "constructor", "prototype", "a.b", "a[b]"]) {
      expect(sanitizeFieldKey(key)).toBeNull();
      expect(sanitizeFormFieldKey(key)).toBeNull();
    }
    expect(sanitizeFieldKey("custom_field-1")).toBe("custom_field-1");
  });

  it("sanitizes CSV headers and values without creating prototype keys", () => {
    const csv = [
      "name,email,__proto__,constructor,name",
      "Alice,alice@example.com,polluted,yes,Duplicate",
      "Bob,bob@example.com,polluted,yes,Duplicate",
    ].join("\n");
    const result = sanitizeCsvRecords(csv, ["name", "email", "owner"]);
    expect(result.rejectedHeaders).toEqual(["__proto__", "constructor"]);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
    expect(Object.prototype.hasOwnProperty.call(result.records[0], "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps only declared form fields and sanitizes photo values", () => {
    const fields: FieldSpec[] = [
      { key: "name", label: "Name" },
      { key: "avatar", label: "Avatar", type: "photo" },
      { key: "__proto__", label: "Blocked" },
    ];
    const values = JSON.parse(
      '{"name":"Alice","avatar":"javascript:alert(1)","__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    expect(sanitizeFormValues(values, fields)).toEqual({
      name: "Alice",
      avatar: "",
    });
  });
});

describe("accessibility and permissions", () => {
  it("recognizes keyboard activation keys without firing on modifier keys", () => {
    expect(isActivationKey("Enter")).toBe(true);
    expect(isActivationKey(" ")).toBe(true);
    expect(isActivationKey("Spacebar")).toBe(true);
    expect(isActivationKey("Escape")).toBe(false);
  });

  it("grants record mutations only to member and admin roles", () => {
    expect(canManageRecords("viewer")).toBe(false);
    expect(canManageRecords("member")).toBe(true);
    expect(canManageRecords("Owner")).toBe(true);
    expect(canManageRecords(undefined)).toBe(false);
  });
});
