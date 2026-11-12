import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as forms from "../forms.js";

const {
  create,
  findAll,
  findById,
  findByPermalink,
  incrementSubmissions,
  update,
} = forms;
const deleteForm = forms.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("forms repository", () => {
  it("lists forms with default pagination and total pages", async () => {
    const data = [{ id: "form-1" }];
    setFindAllResult(21, data);

    await expect(findAll()).resolves.toEqual({
      data,
      total: 21,
      page: 1,
      limit: 20,
      totalPages: 2,
    });
    expect(pg.query.mock.calls[0][0]).toContain("FROM forms");
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
    const result = await findAll({ page: 2, limit: 500 });

    expect(result.limit).toBe(100);
    expect(pg.query.mock.calls[1][1]).toEqual([100, 100]);
  });

  it("searches name, title, permalink and description", async () => {
    setFindAllResult(1, [{ id: "form-1" }]);

    await findAll({ q: "demo" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("name ILIKE $1");
    expect(countSql).toContain("title ILIKE $1");
    expect(countSql).toContain("permalink ILIKE $1");
    expect(countSql).toContain("description ILIKE $1");
    expect(countParams).toEqual(["%demo%"]);
  });

  it("filters submitTo exactly, case-insensitively", async () => {
    setFindAllResult(1, [{ id: "form-1" }]);

    await findAll({ submitTo: "Contact" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("LOWER(COALESCE(submit_to, '')) = $1");
    expect(countParams).toEqual(["contact"]);
  });

  // "false" is a non-empty string, and a non-empty string is truthy in SQL, so
  // a naive `WHERE enabled = $1` with "false" would return the *enabled* forms.
  it("coerces the enabled filter to a real boolean", async () => {
    for (const [input, expected] of [
      ["false", false],
      ["true", true],
      [false, false],
      [true, true],
    ]) {
      pg.query.mockReset();
      setFindAllResult(0);
      await findAll({ enabled: input });
      const [countSql, countParams] = pg.query.mock.calls[0];
      expect(countSql).toContain("enabled = $1");
      expect(countParams).toEqual([expected]);
    }
  });

  it("omits the enabled filter when it is not supplied", async () => {
    setFindAllResult(0);

    await findAll({ enabled: "" });

    expect(pg.query.mock.calls[0][0]).not.toContain("enabled = $1");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("allows every whitelisted sort and rejects malformed sorts", async () => {
    for (const column of [
      "created_at",
      "updated_at",
      "name",
      "permalink",
      "enabled",
      "submission_count",
    ]) {
      pg.query.mockReset();
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:desc` });
      expect(pg.query.mock.calls[1][0]).toContain(`ORDER BY ${column} DESC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "permalink; DROP TABLE forms" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds a form by id and returns null when absent", async () => {
    const record = { id: "form-1" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("form-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM forms WHERE id = $1",
      ["form-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  // The public render and submit endpoints are both unauthenticated and keyed by
  // permalink, so a disabled form has to be invisible here rather than filtered
  // out by the caller.
  it("looks a form up by permalink, excluding disabled ones", async () => {
    const record = { id: "form-1", permalink: "demo" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(findByPermalink("demo")).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("WHERE permalink = $1");
    expect(sql).toContain("enabled IS NOT FALSE");
    expect(params).toEqual(["demo"]);

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findByPermalink("missing")).resolves.toBeNull();
  });

  it("serializes the fields array as jsonb rather than a Postgres array literal", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({
      name: "Demo",
      permalink: "demo",
      fields: [{ key: "email", type: "email" }],
    });

    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO forms");
    // An unserialized JS array binds as {a,b} and the server rejects it with
    // 22P02 "invalid input syntax for type json".
    expect(params[9]).toBe('[{"key":"email","type":"email"}]');
  });

  it("defaults fields to an empty array and settings to an empty object", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ name: "Demo" });

    const params = pg.query.mock.calls[0][1];
    expect(params[9]).toBe("[]");
    expect(params[10]).toBe("{}");
  });

  // Left null so the column DEFAULT TRUE applies, and so the counter starts at
  // the column default rather than an explicit zero.
  it("leaves booleans and the counter null when unset", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ name: "Demo" });

    const params = pg.query.mock.calls[0][1];
    expect(params[6]).toBeNull();
    expect(params[8]).toBeNull();
    expect(params[11]).toBeNull();
  });

  it("passes explicit booleans and the counter through", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ name: "Demo", enabled: false, progressive: true, submission_count: 0 });

    const params = pg.query.mock.calls[0][1];
    expect(params[6]).toBe(true);
    expect(params[8]).toBe(false);
    expect(params[11]).toBe(0);
  });

  it("updates only whitelisted fields and re-serializes the array", async () => {
    const record = { id: "form-1" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("form-1", {
      fields: [{ key: "email" }],
      enabled: false,
      workspace_id: "ignored",
      id: "hacked",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    // Assignments follow UPDATE_FIELDS, not the order of the input object.
    expect(sql).toContain("enabled = $1, fields = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(sql).not.toContain("workspace_id = $");
    // A client-supplied id must not become an assignment. WHERE id is expected,
    // so the check is scoped to the SET clause.
    const setClause = sql.slice(sql.indexOf("SET"), sql.indexOf("WHERE"));
    expect(setClause).not.toContain("id = $");
    expect(params).toEqual([false, '[{"key":"email"}]', "form-1"]);
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("form-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { name: "x" })).resolves.toBeNull();
  });

  // A visitor submission is not an edit of the form definition. The trigger in
  // migration 008 keeps updated_at stable for a counter-only change, so this
  // statement must not name the column either.
  it("increments the submission counter without touching updated_at", async () => {
    const record = { id: "form-1", submission_count: 4 };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(incrementSubmissions("form-1")).resolves.toBe(record);
    const [sql] = pg.query.mock.calls[0];
    expect(sql).toContain("submission_count = COALESCE(submission_count, 0) + 1");
    expect(sql).not.toContain("updated_at");
    expect(sql).toContain("RETURNING *");
  });

  it("tolerates a null counter when incrementing", async () => {
    const record = { id: "form-1", submission_count: 1 };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await incrementSubmissions("form-1");

    expect(pg.query.mock.calls[0][0]).toContain(
      "COALESCE(submission_count, 0) + 1",
    );
  });

  it("returns null when incrementing a missing form", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(incrementSubmissions("missing")).resolves.toBeNull();
  });

  it("reports whether a form was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "form-1" }] });
    await expect(deleteForm("form-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM forms WHERE id = $1 RETURNING id",
      ["form-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteForm("missing")).resolves.toBe(false);
  });
});
