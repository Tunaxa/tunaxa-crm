import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => {
  const stored = new Map();

  function stableHash(params = {}) {
    const normalized = {};
    for (const key of Object.keys(params).sort()) {
      if (params[key] !== undefined) normalized[key] = params[key];
    }
    return Object.keys(normalized).length > 0
      ? JSON.stringify(normalized)
      : "all";
  }

  return {
    cacheGet: vi.fn(),
    cacheSet: vi.fn(),
    cacheFlush: vi.fn(),
    hashParams: vi.fn(stableHash),
    stored,
  };
});

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));
vi.mock("../../../services/cache.js", () => ({
  cacheGet: cache.cacheGet,
  cacheSet: cache.cacheSet,
  cacheFlush: cache.cacheFlush,
  hashParams: cache.hashParams,
}));

import * as activities from "../activities.js";
import * as companies from "../companies.js";
import * as contacts from "../contacts.js";
import * as deals from "../deals.js";
import * as leads from "../leads.js";
import * as tasks from "../tasks.js";

const repositories = [
  { name: "contacts", repository: contacts, updateData: { first_name: "Updated" } },
  { name: "leads", repository: leads, updateData: { first_name: "Updated" } },
  { name: "companies", repository: companies, updateData: { name: "Updated" } },
  { name: "deals", repository: deals, updateData: { title: "Updated" } },
  { name: "tasks", repository: tasks, updateData: { title: "Updated" } },
  { name: "activities", repository: activities, updateData: { subject: "Updated" } },
];

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
  cache.stored.clear();
  cache.cacheGet.mockReset();
  cache.cacheSet.mockReset();
  cache.cacheFlush.mockReset();
  cache.hashParams.mockClear();
  cache.cacheGet.mockImplementation(async (key) => cache.stored.get(key) ?? null);
  cache.cacheSet.mockImplementation(async (key, value) => {
    cache.stored.set(key, value);
  });
  cache.cacheFlush.mockImplementation(async (pattern) => {
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    for (const key of cache.stored.keys()) {
      if (key.startsWith(prefix)) cache.stored.delete(key);
    }
  });
});

describe("repository query caching", () => {
  for (const { name, repository, updateData } of repositories) {
    describe(name, () => {
      it("caches a miss and serves an identical hit without querying", async () => {
        const params = { page: 2, limit: 10, q: "acme" };
        const data = [{ id: `${name}-1` }];
        setFindAllResult(1, data);

        await expect(repository.findAll(params)).resolves.toEqual({
          data,
          total: 1,
          page: 2,
          limit: 10,
          totalPages: 1,
        });
        const key = `${name}:list:${cache.hashParams.mock.results[0].value}`;
        expect(cache.cacheGet).toHaveBeenNthCalledWith(1, key);
        expect(cache.cacheSet).toHaveBeenCalledWith(key, expect.any(Object), 60);
        expect(pg.query).toHaveBeenCalledTimes(2);

        pg.query.mockClear();
        await expect(
          repository.findAll({ q: "acme", limit: 10, page: 2 }),
        ).resolves.toEqual({
          data,
          total: 1,
          page: 2,
          limit: 10,
          totalPages: 1,
        });
        expect(pg.query).not.toHaveBeenCalled();
        expect(cache.cacheGet).toHaveBeenCalledTimes(2);
      });

      it("uses distinct keys for distinct query parameters", async () => {
        setFindAllResult(1, [{ id: `${name}-first` }]);
        await repository.findAll({ page: 1, limit: 20, q: "first" });
        setFindAllResult(1, [{ id: `${name}-second` }]);
        await repository.findAll({ page: 2, limit: 10, q: "second" });

        const keys = cache.cacheGet.mock.calls.map(([key]) => key);
        expect(keys).toHaveLength(2);
        expect(keys[0]).not.toBe(keys[1]);
        expect(pg.query).toHaveBeenCalledTimes(4);
      });

      it.each(["create", "update", "delete"])(
        "invalidates list cache after %s",
        async (operation) => {
          setFindAllResult(1, [{ id: `${name}-before` }]);
          await repository.findAll({ page: 1 });
          pg.query.mockClear();

          if (operation === "create") {
            pg.query.mockResolvedValueOnce({ rows: [{ id: `${name}-new` }] });
            await repository.create({});
          } else if (operation === "update") {
            pg.query.mockResolvedValueOnce({ rows: [{ id: `${name}-updated` }] });
            await repository.update(`${name}-before`, updateData);
          } else {
            pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: `${name}-before` }] });
            await repository.delete(`${name}-before`);
          }

          expect(cache.cacheFlush).toHaveBeenCalledWith(`${name}:list:*`);

          setFindAllResult(2, [{ id: `${name}-after` }]);
          await expect(repository.findAll({ page: 1 })).resolves.toEqual(
            expect.objectContaining({ total: 2 }),
          );
          expect(pg.query).toHaveBeenCalledTimes(3);
        },
      );
    });
  }
});
