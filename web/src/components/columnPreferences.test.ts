import { describe, expect, it } from "vitest";
import {
  MAX_COLUMN_KEYS,
  columnCacheKey,
  filterRestrictedColumns,
  normalizeColumnKey,
  readCachedKeys,
  readResourceVisibility,
  sanitizeVisibleKeys,
  toColumnVisibility,
  writeCachedKeys,
  type ColumnOption,
} from "./columnPreferences";

const columns: ColumnOption[] = [
  { key: "name", label: "Name", required: true },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
];

const allowed = new Set(columns.map((column) => column.key));
const required = ["name"];

function memoryStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

describe("column key sanitization", () => {
  it("drops unknown keys and always preserves required columns", () => {
    expect(
      sanitizeVisibleKeys(
        ["email", "deleted-field", "__proto__", "phone"],
        allowed,
        required,
      ),
    ).toEqual(["name", "email", "phone"]);
    expect(sanitizeVisibleKeys([], allowed, required)).toEqual(["name"]);
    expect(sanitizeVisibleKeys(true, allowed, required)).toEqual([
      "name",
      "email",
      "phone",
    ]);
    expect(sanitizeVisibleKeys(false, allowed, required)).toEqual(["name"]);
  });

  it("rejects prototype-pollution keys and malformed identifiers", () => {
    for (const key of [
      "__proto__",
      "constructor",
      "prototype",
      "a.__proto__",
      "a[0]",
      "",
      "   ",
      null,
      42,
    ]) {
      expect(normalizeColumnKey(key)).toBeNull();
    }
    expect(
      sanitizeVisibleKeys(
        ["__proto__", "constructor", "prototype", "a.b", "email"],
        allowed,
        required,
      ),
    ).toEqual(["name", "email"]);
  });

  it("caps persisted column arrays at 200 entries", () => {
    const wide = new Set(
      Array.from({ length: MAX_COLUMN_KEYS + 50 }, (_, index) => `c${index}`),
    );
    expect(sanitizeVisibleKeys(true, wide, [])).toHaveLength(MAX_COLUMN_KEYS);
  });

  it("builds a null-prototype columnVisibility map with sanitized keys", () => {
    const map = toColumnVisibility(
      "contacts",
      ["__proto__", "email", "unknown", "name"],
      allowed,
    );
    expect(Object.getPrototypeOf(map)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(map, "contacts")).toBe(true);
    expect(map.contacts).toEqual(["email", "name"]);
  });
});

describe("server preference hydration", () => {
  it("reads resource visibility from the API payload", () => {
    const payload = {
      preferences: {
        columnVisibility: {
          contacts: ["email", "__proto__", "bogus"],
        },
      },
    };
    expect(
      readResourceVisibility(payload, "contacts", allowed, required),
    ).toEqual(["name", "email"]);
    expect(readResourceVisibility(payload, "leads", allowed, required)).toBeNull();
  });

  it("ignores malformed payloads and non-object visibility maps", () => {
    expect(readResourceVisibility(null, "contacts", allowed, required)).toBeNull();
    expect(
      readResourceVisibility(
        { columnVisibility: ["email"] },
        "contacts",
        allowed,
        required,
      ),
    ).toBeNull();
    expect(
      readResourceVisibility(
        { preferences: { columnVisibility: { contacts: "email" } } },
        "contacts",
        allowed,
        required,
      ),
    ).toEqual(["name"]);
  });
});

describe("scoped localStorage fallback", () => {
  it("scopes the cache by workspace, user, and resource", () => {
    expect(columnCacheKey("w1", "u1", "contacts")).toBe(
      "tunaxa:columns:v2:w1:u1:contacts",
    );
    const storage = memoryStorage();
    const key = columnCacheKey("w1", "u1", "contacts");
    writeCachedKeys(storage, key, ["email", "__proto__", "unknown"]);
    expect(readCachedKeys(storage, key, allowed, required)).toEqual([
      "name",
      "email",
    ]);
    expect(
      readCachedKeys(storage, columnCacheKey("w2", "u1", "contacts"), allowed, required),
    ).toBeNull();
  });

  it("survives invalid JSON and inaccessible storage", () => {
    const broken = memoryStorage({ key: "not-json" });
    expect(readCachedKeys(broken, "key", allowed, required)).toBeNull();
    expect(
      readCachedKeys(
        {
          getItem: () => {
            throw new Error("blocked");
          },
        },
        "key",
        allowed,
        required,
      ),
    ).toBeNull();
  });
});

describe("schema field-mask filtering", () => {
  it("excludes hidden and masked fields from selectable columns", () => {
    const schema = {
      hiddenFields: ["ssn"],
      maskedFields: ["salary"],
      fields: [
        { key: "secret", masked: true },
        { name: "note", hidden: true },
        { key: "name" },
      ],
    };
    const options: ColumnOption[] = [
      { key: "name", label: "Name", required: true },
      { key: "email", label: "Email" },
      { key: "ssn", label: "SSN" },
      { key: "salary", label: "Salary" },
      { key: "secret", label: "Secret" },
      { key: "note", label: "Note" },
    ];
    expect(filterRestrictedColumns(options, schema).map((column) => column.key)).toEqual(
      ["name", "email"],
    );
    expect(filterRestrictedColumns(options, null)).toEqual(options);
  });
});
