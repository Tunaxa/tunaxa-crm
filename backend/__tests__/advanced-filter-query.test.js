import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { closePool } from "../db/pg.js";
import { resetTestDb, seedTestUser, loginAs } from "./setup.js";
import { mutateDb } from "../store.js";

let app;
let token;

const LEAD_FIXTURES = [
  {
    id: "lead_afq_1",
    firstName: "Alice",
    lastName: "Anderson",
    email: "alice@acme.com",
    company: "Acme Corporation",
    status: "open",
    score: 90,
    createdAt: "2024-01-05T00:00:00.000Z",
    tags: ["hot", "enterprise"],
    notes: "warm intro from sales",
  },
  {
    id: "lead_afq_2",
    firstName: "Bob",
    lastName: "Brown",
    email: "bob@globex.io",
    company: "Globex",
    status: "won",
    score: 40,
    createdAt: "2024-03-15T00:00:00.000Z",
    tags: [],
    notes: "",
  },
  {
    id: "lead_afq_3",
    firstName: "Cara",
    lastName: "Carter",
    email: "cara@initech.co",
    company: "Initech",
    status: "open",
    score: 70,
    createdAt: "2024-06-20T00:00:00.000Z",
    notes: null,
  },
  {
    id: "lead_afq_4",
    firstName: "Dan",
    lastName: "anderson",
    email: "dan@umbrella.net",
    company: "Umbrella",
    status: "closed",
    score: 0,
    createdAt: "2023-12-01T00:00:00.000Z",
    notes: "no score yet",
  },
];

const MESSAGE_FIXTURES = Array.from({ length: 5 }, (_, i) => ({
  id: `msg_afq_${i + 1}`,
  channel: i % 2 === 0 ? "email" : "sms",
  to: `person${i + 1}@example.com`,
  subject: `Message ${i + 1}`,
  body: "hello",
  createdAt: `2024-0${i + 1}-01T00:00:00.000Z`,
}));

// Drives GET /api/:resource with an optional advanced filter payload.
const get = (resource, { filters, ...rest } = {}) => {
  const query = new URLSearchParams(rest).toString();
  const encoded = filters === undefined ? "" : `filters=${encodeURIComponent(filters)}`;
  const search = [query, encoded].filter(Boolean).join("&");

  return request(app)
    .get(`/api/${resource}${search ? `?${search}` : ""}`)
    .set("Authorization", `Bearer ${token}`);
};

const ids = res => res.body.map(row => row.id).sort();

beforeAll(async () => {
  await resetTestDb();
  const mod = await import("../server.js");
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);

  await mutateDb(db => {
    db.leads.push(...LEAD_FIXTURES);
    db.messages.push(...MESSAGE_FIXTURES);
  });
});

afterAll(async () => {
  await closePool();
});

// A payload that passes parsing/validation, used as a baseline for 400s.
const expect400 = async (filters, fragment) => {
  const res = await get("leads", { filters });
  expect(res.status).toBe(400);
  expect(res.body.error).toBeTruthy();
  if (fragment) expect(res.body.error).toContain(fragment);
};

describe("advanced filters: payload validation", () => {
  it("rejects malformed JSON", async () => {
    await expect400('{"field":"status",', "not valid JSON");
  });

  it("rejects JSON that is not an object", async () => {
    await expect400("[1,2,3]", "must be an object");
    await expect400('"hello"', "must be an object");
    await expect400("42", "must be an object");
    await expect400("null", "must be an object");
  });

  it("rejects an empty object", async () => {
    await expect400("{}", "must not be empty");
  });

  it("rejects an unrecognized operator", async () => {
    await expect400(
      '{"field":"score","operator":"between","value":5}',
      'operator "between" is not supported',
    );
  });

  it("rejects an unrecognized operator nested inside a group", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({
        $and: [{ field: "score", operator: "eq", value: 10 }, { field: "x", operator: "gte", value: 1 }],
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("filters.$and[1].operator");
    expect(res.body.error).toContain('"gte"');
  });

  it("rejects a missing or non-string field", async () => {
    await expect400('{"operator":"eq","value":"open"}', "field must be a non-empty string");
    await expect400('{"field":"  ","operator":"eq","value":"open"}', "field must be a non-empty string");
    await expect400('{"field":7,"operator":"eq","value":"open"}', "field must be a non-empty string");
  });

  it("rejects a missing operator", async () => {
    await expect400('{"field":"status","value":"open"}', "operator must be a non-empty string");
  });

  it("rejects a missing value for operators that need one", async () => {
    await expect400('{"field":"score","operator":"eq"}', 'value is required for operator "eq"');
    await expect400('{"field":"score","operator":"gt"}', 'value is required for operator "gt"');
  });

  it("rejects unknown keys on a condition", async () => {
    await expect400('{"field":"status","operator":"eq","value":"open","op":"eq"}', 'unknown key "op"');
  });

  it("rejects a logical key whose value is not an array", async () => {
    await expect400('{"$and":{"field":"status","operator":"eq","value":"open"}}', "$and must be an array");
  });

  it("rejects an empty logical group", async () => {
    await expect400('{"$or":[]}', "must contain at least one condition");
  });

  it("rejects combining two logical operators", async () => {
    await expect400(
      '{"$and":[{"field":"status","operator":"eq","value":"open"}],"$or":[{"field":"score","operator":"eq","value":1}]}',
      "combines $and and $or",
    );
  });

  it("rejects mixing a logical key with condition keys", async () => {
    await expect400(
      '{"$and":[{"field":"status","operator":"eq","value":"open"}],"field":"score","operator":"eq","value":1}',
      "mixes",
    );
  });

  it("rejects a blank filters value", async () => {
    const res = await get("leads", { filters: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must not be empty");
  });

  it("leaves the listing untouched when no filters param is sent", async () => {
    const res = await get("leads");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(LEAD_FIXTURES.length);
  });
});

describe("advanced filters: eq and neq", () => {
  it("eq matches strict equality", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({ field: "status", operator: "eq", value: "open" }),
    });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(["lead_afq_1", "lead_afq_3"]);
  });

  it("eq is strict about types, so 90 does not match \"90\"", async () => {
    const numeric = await get("leads", {
      filters: JSON.stringify({ field: "score", operator: "eq", value: 90 }),
    });
    const stringy = await get("leads", {
      filters: JSON.stringify({ field: "score", operator: "eq", value: "90" }),
    });
    expect(ids(numeric)).toEqual(["lead_afq_1"]);
    expect(stringy.body).toEqual([]);
  });

  it("eq does not match a missing field", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({ field: "nonexistent", operator: "eq", value: "x" }),
    });
    expect(res.body).toEqual([]);
  });

  it("eq on null only matches an explicit null", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({ field: "notes", operator: "eq", value: null }),
    });
    expect(ids(res)).toEqual(["lead_afq_3"]);
  });

  it("neq is the complement of eq, including for missing fields", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({ field: "status", operator: "neq", value: "open" }),
    });
    expect(ids(res)).toEqual(["lead_afq_2", "lead_afq_4"]);
  });
});

describe("advanced filters: contains", () => {
  it("is a case-insensitive substring match", async () => {
    const upper = await get("leads", {
      filters: JSON.stringify({ field: "lastName", operator: "contains", value: "ANDERSON" }),
    });
    const lower = await get("leads", {
      filters: JSON.stringify({ field: "lastName", operator: "contains", value: "anderson" }),
    });
    expect(ids(upper)).toEqual(["lead_afq_1", "lead_afq_4"]);
    expect(ids(lower)).toEqual(["lead_afq_1", "lead_afq_4"]);
  });

  it("matches mid-string, not just at the start", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({ field: "email", operator: "contains", value: "@initech" }),
    });
    expect(ids(res)).toEqual(["lead_afq_3"]);
  });

  it("does not match a missing or null field", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({ field: "nonexistent", operator: "contains", value: "a" }),
    });
    expect(res.body).toEqual([]);
  });
});

describe("advanced filters: starts_with", () => {
  it("matches a case-insensitive prefix", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({ field: "company", operator: "starts_with", value: "ac" }),
    });
    expect(ids(res)).toEqual(["lead_afq_1"]);
  });

  it("does not match a substring that is not at the start", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({ field: "company", operator: "starts_with", value: "corporation" }),
    });
    expect(res.body).toEqual([]);
  });

  it("does not match a missing or null field", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({ field: "nonexistent", operator: "starts_with", value: "a" }),
    });
    expect(res.body).toEqual([]);
  });
});

describe("advanced filters: gt and lt", () => {
  it("compares numbers", async () => {
    const gt = await get("leads", {
      filters: JSON.stringify({ field: "score", operator: "gt", value: 60 }),
    });
    const lt = await get("leads", {
      filters: JSON.stringify({ field: "score", operator: "lt", value: 60 }),
    });
    expect(ids(gt)).toEqual(["lead_afq_1", "lead_afq_3"]);
    expect(ids(lt)).toEqual(["lead_afq_2", "lead_afq_4"]);
  });

  it("is exclusive at the boundary", async () => {
    const gt = await get("leads", {
      filters: JSON.stringify({ field: "score", operator: "gt", value: 70 }),
    });
    const lt = await get("leads", {
      filters: JSON.stringify({ field: "score", operator: "lt", value: 70 }),
    });
    expect(ids(gt)).toEqual(["lead_afq_1"]);
    expect(ids(lt)).toEqual(["lead_afq_2", "lead_afq_4"]);
  });

  it("compares a numeric field against a numeric string", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({ field: "score", operator: "gt", value: "40" }),
    });
    expect(ids(res)).toEqual(["lead_afq_1", "lead_afq_3"]);
  });

  it("compares ISO date strings chronologically", async () => {
    const gt = await get("leads", {
      filters: JSON.stringify({ field: "createdAt", operator: "gt", value: "2024-03-15" }),
    });
    const lt = await get("leads", {
      filters: JSON.stringify({ field: "createdAt", operator: "lt", value: "2024-03-15" }),
    });
    // lead_afq_1 = 2024-01-05 (before), lead_afq_2 = 2024-03-15 (equal, excluded),
    // lead_afq_3 = 2024-06-20 (after), lead_afq_4 = 2023-12-01 (before).
    expect(ids(gt)).toEqual(["lead_afq_3"]);
    expect(ids(lt)).toEqual(["lead_afq_1", "lead_afq_4"]);
  });

  it("is exclusive at the date boundary too", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({ field: "createdAt", operator: "gt", value: "2024-06-20" }),
    });
    expect(res.body).toEqual([]);
  });

  it("does not match when the value is not comparable", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({ field: "status", operator: "gt", value: 5 }),
    });
    expect(res.body).toEqual([]);
  });
});

describe("advanced filters: is_set", () => {
  it("is true for a populated field", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({ field: "company", operator: "is_set" }),
    });
    expect(res.body).toHaveLength(LEAD_FIXTURES.length);
  });

  it("is false for an empty string, null, empty array, or missing field", async () => {
    const emptyString = await get("leads", {
      filters: JSON.stringify({ field: "notes", operator: "is_set" }),
    });
    // lead_afq_2 notes === "", lead_afq_3 notes === null, 1 and 4 are populated.
    expect(ids(emptyString)).toEqual(["lead_afq_1", "lead_afq_4"]);

    const emptyArray = await get("leads", {
      filters: JSON.stringify({ field: "tags", operator: "is_set" }),
    });
    // lead_afq_2 has tags: []; leads 3 and 4 have no tags key at all.
    expect(ids(emptyArray)).toEqual(["lead_afq_1"]);

    const missing = await get("leads", {
      filters: JSON.stringify({ field: "nonexistent", operator: "is_set" }),
    });
    expect(missing.body).toEqual([]);
  });

  it("treats 0 and false as set values", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({ field: "score", operator: "is_set", value: false }),
    });
    expect(res.body).toHaveLength(LEAD_FIXTURES.length);
  });
});

describe("advanced filters: logical grouping", () => {
  it("applies $and across eq and gt", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({
        $and: [
          { field: "status", operator: "eq", value: "open" },
          { field: "score", operator: "gt", value: 80 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(["lead_afq_1"]);
  });

  it("applies $and across three conditions", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({
        $and: [
          { field: "status", operator: "eq", value: "open" },
          { field: "score", operator: "gt", value: 0 },
          { field: "company", operator: "starts_with", value: "acme" },
        ],
      }),
    });
    expect(ids(res)).toEqual(["lead_afq_1"]);
  });

  it("accepts AND and OR without the $ sigil", async () => {
    const upperAnd = await get("leads", {
      filters: JSON.stringify({
        AND: [
          { field: "status", operator: "eq", value: "open" },
          { field: "score", operator: "lt", value: 80 },
        ],
      }),
    });
    const upperOr = await get("leads", {
      filters: JSON.stringify({
        OR: [
          { field: "status", operator: "eq", value: "won" },
          { field: "company", operator: "eq", value: "Umbrella" },
        ],
      }),
    });
    expect(ids(upperAnd)).toEqual(["lead_afq_3"]);
    expect(ids(upperOr)).toEqual(["lead_afq_2", "lead_afq_4"]);
  });

  it("applies $or as a union", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({
        $or: [
          { field: "status", operator: "eq", value: "won" },
          { field: "score", operator: "gt", value: 85 },
        ],
      }),
    });
    expect(ids(res)).toEqual(["lead_afq_1", "lead_afq_2"]);
  });

  it("evaluates nested groups recursively", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({
        $or: [
          {
            $and: [
              { field: "status", operator: "eq", value: "open" },
              { field: "score", operator: "gt", value: 85 },
            ],
          },
          { field: "lastName", operator: "eq", value: "Brown" },
        ],
      }),
    });
    expect(ids(res)).toEqual(["lead_afq_1", "lead_afq_2"]);
  });

  it("nests three levels deep", async () => {
    const res = await get("leads", {
      filters: JSON.stringify({
        $and: [
          {
            $or: [
              { field: "company", operator: "eq", value: "Globex" },
              {
                $and: [
                  { field: "status", operator: "neq", value: "closed" },
                  { field: "score", operator: "gt", value: 65 },
                ],
              },
            ],
          },
          { field: "email", operator: "is_set" },
        ],
      }),
    });
    expect(ids(res)).toEqual(["lead_afq_1", "lead_afq_2", "lead_afq_3"]);
  });
});

describe("advanced filters: composition with existing query handling", () => {
  it("compounds with the q text search", async () => {
    const res = await get("leads", {
      q: "globex",
      filters: JSON.stringify({ field: "status", operator: "eq", value: "won" }),
    });
    expect(ids(res)).toEqual(["lead_afq_2"]);

    const mismatch = await get("leads", {
      q: "globex",
      filters: JSON.stringify({ field: "status", operator: "eq", value: "open" }),
    });
    expect(mismatch.body).toEqual([]);
  });

  it("compounds with the activities type filter", async () => {
    await mutateDb(db => {
      db.activities.push(
        {
          id: "act_afq_1",
          type: "email",
          title: "kickoff",
          recordId: "lead_afq_1",
          createdAt: "2024-01-05T00:00:00.000Z",
        },
        {
          id: "act_afq_2",
          type: "meeting",
          title: "review",
          recordId: "lead_afq_2",
          createdAt: "2024-01-06T00:00:00.000Z",
        },
      );
    });

    const res = await get("activities", {
      type: "email",
      filters: JSON.stringify({ field: "recordId", operator: "eq", value: "lead_afq_1" }),
    });
    expect(ids(res)).toEqual(["act_afq_1"]);
  });

  it("compounds with messages pagination and reports the filtered total", async () => {
    const filtered = await get("messages", {
      filters: JSON.stringify({ field: "channel", operator: "eq", value: "email" }),
    });
    expect(filtered.status).toBe(200);
    expect(filtered.body.total).toBe(3);
    expect(filtered.body.items).toHaveLength(3);

    const paged = await get("messages", {
      limit: "2",
      page: "2",
      filters: JSON.stringify({ field: "channel", operator: "eq", value: "email" }),
    });
    expect(paged.body.total).toBe(3);
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.hasMore).toBe(false);
  });

  it("keeps the existing unfiltered pagination contract intact", async () => {
    const res = await get("messages", { limit: "2", page: "1" });
    expect(res.body.total).toBe(MESSAGE_FIXTURES.length);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.hasMore).toBe(true);
  });

  it("leaves an unknown resource to fall through, even with an invalid payload", async () => {
    const res = await get("wombats", { filters: "not-json" });
    expect(res.status).not.toBe(400);
    expect(res.status).toBe(404);
  });

  it("still requires auth", async () => {
    const res = await request(app)
      .get(`/api/leads?filters=${encodeURIComponent(JSON.stringify({ field: "status", operator: "eq", value: "open" }))}`);
    expect(res.status).toBe(401);
  });
});