import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import {
  cleanupTestDb,
  loginAs,
  resetTestDb,
  seedTestUser,
} from "./setup.js";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  QueryParamError,
  buildPaginationEnvelope,
  normalizeListQuery,
  normalizeSortBy,
  sortRecords,
} from "../middleware/pagination.js";

let app;
let token;

const as = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await resetTestDb();
  const module = await import("../server.js");
  app = module.app;
  await seedTestUser();
  token = await loginAs(app);
});

afterAll(async () => {
  await cleanupTestDb();
});

describe("normalizeListQuery", () => {
  it("uses dev's canonical defaults, including limit 25", () => {
    expect(normalizeListQuery({})).toEqual({
      page: 1,
      limit: 25,
      sortBy: "createdAt",
      sortDir: "desc",
    });
    expect(DEFAULT_LIMIT).toBe(25);
    expect(MAX_LIMIT).toBe(100);
  });

  it("clamps page and limit without changing the defaults", () => {
    expect(normalizeListQuery({ page: "-7" }).page).toBe(1);
    expect(normalizeListQuery({ page: "0" }).page).toBe(1);
    expect(normalizeListQuery({ limit: "0" }).limit).toBe(25);
    expect(normalizeListQuery({ limit: "-5" }).limit).toBe(25);
    expect(normalizeListQuery({ limit: "abc" }).limit).toBe(25);
    expect(normalizeListQuery({ limit: "999" }).limit).toBe(100);
    expect(normalizeListQuery({ page: "2.9" }).page).toBe(2);
    expect(normalizeListQuery({ limit: "5.5" }).limit).toBe(5);
  });

  it("honours an explicit defaultLimit override", () => {
    expect(normalizeListQuery({}, { defaultLimit: 50 }).limit).toBe(50);
  });

  it("rejects repeated and array-shaped list controls with a 400 error", () => {
    const repeated = [
      { page: ["1", "2"] },
      { limit: ["10", "20"] },
      { sortBy: ["name", "title"] },
      { sortDir: ["asc", "desc"] },
      { order: ["asc"] },
      { q: ["a", "b"] },
      { search: ["a"] },
      // Express' simple query parser produces these literal keys.
      { "page[]": "1" },
      { "limit[]": "10" },
      { "sortBy[]": "name" },
    ];
    for (const query of repeated) {
      expect(() => normalizeListQuery(query)).toThrow(QueryParamError);
      try {
        normalizeListQuery(query);
      } catch (error) {
        expect(error.status).toBe(400);
      }
    }
  });

  it("normalizes sort direction and the legacy inline form", () => {
    expect(normalizeListQuery({ sortDir: "ASC" }).sortDir).toBe("asc");
    expect(normalizeListQuery({ sortBy: "created_at:asc" })).toMatchObject({
      sortBy: "created_at",
      sortDir: "asc",
    });
    expect(
      normalizeListQuery({ sortBy: "created_at:asc", order: "desc" }),
    ).toMatchObject({ sortBy: "created_at", sortDir: "desc" });
  });
});

describe("normalizeSortBy", () => {
  it("rejects prototype-pollution keys, dotted paths and invalid characters", () => {
    const unsafe = [
      "__proto__",
      "constructor",
      "prototype",
      "user.name",
      "a.b",
      "a b",
      "name;DROP TABLE",
      "field[0]",
      "",
    ];
    for (const field of unsafe) {
      expect(normalizeSortBy(field)).toBe("createdAt");
    }
  });

  it("accepts safe camelCase and snake_case identifiers", () => {
    expect(normalizeSortBy("firstName")).toBe("firstName");
    expect(normalizeSortBy("first_name")).toBe("first_name");
  });

  it("enforces an allowlist when one is supplied", () => {
    expect(normalizeSortBy("name", ["name", "title"])).toBe("name");
    expect(normalizeSortBy("secret", ["name", "title"])).toBe("createdAt");
    expect(normalizeSortBy("name", new Set(["title"]))).toBe("createdAt");
  });
});

describe("sortRecords", () => {
  const rows = [
    { name: "b", value: 2 },
    { name: "a", value: null },
    { name: "c", value: 1 },
    { name: "d" },
  ];

  it("sorts numerically with null and missing values last in both directions", () => {
    expect(sortRecords(rows, "value", "asc").map((r) => r.name)).toEqual([
      "c",
      "b",
      "a",
      "d",
    ]);
    expect(sortRecords(rows, "value", "desc").map((r) => r.name)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("is stable for equal values and does not mutate its input", () => {
    const tied = [
      { name: "x", value: 1, id: 1 },
      { name: "y", value: 1, id: 2 },
    ];
    const sorted = sortRecords(tied, "value", "desc");
    expect(sorted.map((r) => r.id)).toEqual([1, 2]);
    expect(sorted).not.toBe(tied);
    expect(tied.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("buildPaginationEnvelope", () => {
  it("computes totalPages and preserves dev's four canonical keys", () => {
    const envelope = buildPaginationEnvelope({
      data: [{ id: "1" }],
      total: 137,
      page: 2,
      limit: 25,
    });
    expect(envelope).toEqual({
      data: [{ id: "1" }],
      total: 137,
      page: 2,
      limit: 25,
      totalPages: 6,
    });
  });

  it("reports zero totalPages for an empty result and clamps controls", () => {
    expect(
      buildPaginationEnvelope({ data: [], total: 0, page: 1, limit: 25 })
        .totalPages,
    ).toBe(0);
    const clamped = buildPaginationEnvelope({
      data: [],
      total: 10,
      page: 0,
      limit: 999,
    });
    expect(clamped.page).toBe(1);
    expect(clamped.limit).toBe(100);
  });
});

describe("GET list endpoints", () => {
  it("returns 400 for array query params on a postgres-backed list", async () => {
    for (const query of ["page[]=1", "page=1&page=2", "sortBy[]=name"]) {
      const response = await request(app)
        .get(`/api/leads?${query}`)
        .set(as());
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/single value/);
    }
  });

  it("returns 400 for array query params on a JSON-backed list", async () => {
    const response = await request(app)
      .get("/api/workflows?limit[]=10")
      .set(as());
    expect(response.status).toBe(400);
  });

  it("keeps dev's envelope and default limit 25 for normal requests", async () => {
    const leads = await request(app).get("/api/leads").set(as());
    expect(leads.status).toBe(200);
    expect(leads.body).toHaveProperty("data");
    expect(leads.body).toHaveProperty("total");
    expect(leads.body.page).toBe(1);
    expect(leads.body.limit).toBe(25);
    expect(Array.isArray(leads.body.data)).toBe(true);

    const workflows = await request(app).get("/api/workflows").set(as());
    expect(workflows.status).toBe(200);
    expect(workflows.body).toHaveProperty("data", expect.any(Array));
    expect(workflows.body.limit).toBe(25);
    expect(workflows.body.page).toBe(1);
  });
});
