import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as emailLists from "../email-lists.js";

const { create, findAll, findById, update } = emailLists;
const deleteList = emailLists.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("email_lists repository", () => {
  it("lists lists with default pagination and total pages", async () => {
    const data = [{ id: "list-1" }];
    setFindAllResult(21, data);

    await expect(findAll()).resolves.toEqual({
      data,
      total: 21,
      page: 1,
      limit: 20,
      totalPages: 2,
    });
    expect(pg.query.mock.calls[0][0]).toContain("FROM email_lists");
    expect(pg.query.mock.calls[1][0]).toContain("ORDER BY created_at DESC");
    expect(pg.query.mock.calls[1][1]).toEqual([20, 0]);
  });

  it("validates pagination and caps the limit at 100", async () => {
    await expect(findAll({ page: 0 })).rejects.toThrow(
      "page must be a positive integer",
    );
    await expect(findAll({ limit: 0 })).rejects.toThrow(
      "limit must be a positive integer",
    );

    setFindAllResult(0);
    const result = await findAll({ page: 2, limit: 250 });

    expect(result.limit).toBe(100);
    expect(pg.query.mock.calls[1][1]).toEqual([100, 100]);
  });

  it("searches name and description with a parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "list-1" }]);

    await findAll({ q: "news" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("name ILIKE $1");
    expect(countSql).toContain("description ILIKE $1");
    expect(countParams).toEqual(["%news%"]);
  });

  it("filters status exactly rather than fuzzily", async () => {
    setFindAllResult(1, [{ id: "list-1" }]);

    await findAll({ status: "Active" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("LOWER(COALESCE(status, '')) = $1");
    expect(countSql).not.toContain("status ILIKE $1");
    expect(countParams).toEqual(["active"]);
  });

  it("ignores blank filters", async () => {
    setFindAllResult(0);

    await findAll({ q: "", status: "  " });

    expect(pg.query.mock.calls[0][0]).not.toContain("COALESCE(status");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("allows every whitelisted sort and rejects malformed sorts", async () => {
    for (const column of [
      "created_at",
      "updated_at",
      "name",
      "status",
      "subscribers",
    ]) {
      pg.query.mockReset();
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:asc` });
      expect(pg.query.mock.calls[1][0]).toContain(`ORDER BY ${column} ASC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "name; DROP TABLE email_lists" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds a list by id and returns null when absent", async () => {
    const record = { id: "list-1" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("list-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM email_lists WHERE id = $1",
      ["list-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  // `subscribers` is a count, not an address list: helpers.js coerces it with
  // Number() and the UI renders a number input, so it has to reach Postgres as
  // a number rather than the string a form or CSV import would send.
  it("coerces the subscriber count to a number on create", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ name: "Newsletter", subscribers: "42" });

    expect(pg.query.mock.calls[0][1][4]).toBe(42);
  });

  it("leaves the subscriber count null when unset so the column default applies", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ name: "Newsletter" });

    expect(pg.query.mock.calls[0][1][4]).toBeNull();
  });

  it("serializes the custom_fields bag", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ name: "Newsletter", custom_fields: { source: "import" } });

    expect(pg.query.mock.calls[0][1][5]).toBe('{"source":"import"}');
  });

  it("updates only whitelisted fields, coercing and serializing as needed", async () => {
    const record = { id: "list-1", subscribers: 50 };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("list-1", {
      subscribers: "50",
      custom_fields: { tier: "gold" },
      workspace_id: "ignored",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("subscribers = $1, custom_fields = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(sql).not.toContain("workspace_id = $");
    expect(params).toEqual([50, '{"tier":"gold"}', "list-1"]);
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("list-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { name: "x" })).resolves.toBeNull();
  });

  it("reports whether a list was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "list-1" }] });
    await expect(deleteList("list-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM email_lists WHERE id = $1 RETURNING id",
      ["list-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteList("missing")).resolves.toBe(false);
  });
});
