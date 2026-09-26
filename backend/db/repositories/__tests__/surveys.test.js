import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as surveys from "../surveys.js";

const { create, findAll, findById, update } = surveys;
const deleteSurvey = surveys.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("surveys repository", () => {
  it("lists surveys with default pagination and total pages", async () => {
    const data = [{ id: "survey-1" }];
    setFindAllResult(21, data);

    await expect(findAll()).resolves.toEqual({
      data,
      total: 21,
      page: 1,
      limit: 20,
      totalPages: 2,
    });
    expect(pg.query.mock.calls[0][0]).toContain("FROM surveys");
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
    const result = await findAll({ page: 4, limit: 500 });

    expect(result.limit).toBe(100);
    expect(pg.query.mock.calls[1][1]).toEqual([100, 300]);
  });

  it("searches name, title, question and description", async () => {
    setFindAllResult(1, [{ id: "survey-1" }]);

    await findAll({ q: "nps" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("name ILIKE $1");
    expect(countSql).toContain("title ILIKE $1");
    expect(countSql).toContain("question ILIKE $1");
    expect(countSql).toContain("description ILIKE $1");
    expect(countParams).toEqual(["%nps%"]);
  });

  it("filters status, type and audience exactly with independent parameters", async () => {
    setFindAllResult(1, [{ id: "survey-1" }]);

    await findAll({ status: "Draft", type: "NPS", audience: "Customers" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("LOWER(COALESCE(status, '')) = $1");
    expect(countSql).toContain("LOWER(COALESCE(type, '')) = $2");
    expect(countSql).toContain("LOWER(COALESCE(audience, '')) = $3");
    expect(countParams).toEqual(["draft", "nps", "customers"]);
  });

  it("ignores blank filters", async () => {
    setFindAllResult(0);

    await findAll({ q: "", status: "  ", type: "", audience: "" });

    expect(pg.query.mock.calls[0][0]).not.toContain("COALESCE(status");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("allows every whitelisted sort and rejects malformed sorts", async () => {
    for (const column of [
      "created_at",
      "updated_at",
      "name",
      "status",
      "type",
      "target_score",
    ]) {
      pg.query.mockReset();
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:asc` });
      expect(pg.query.mock.calls[1][0]).toContain(`ORDER BY ${column} ASC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "name; DROP TABLE surveys" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds a survey by id and returns null when absent", async () => {
    const record = { id: "survey-1" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("survey-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM surveys WHERE id = $1",
      ["survey-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("serializes the questions array as jsonb", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({
      name: "NPS",
      questions: [{ key: "score", type: "number" }],
      target_score: 9,
    });

    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO surveys");
    expect(params[9]).toBe('[{"key":"score","type":"number"}]');
    // helpers.js coerces targetScore with Number(); it must stay a number.
    expect(params[7]).toBe(9);
  });

  it("defaults questions to an empty array", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ name: "NPS" });

    expect(pg.query.mock.calls[0][1][9]).toBe("[]");
  });

  it("updates only whitelisted fields and re-serializes the array", async () => {
    const record = { id: "survey-1" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("survey-1", {
      questions: [{ key: "score" }],
      workspace_id: "ignored",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("questions = $1");
    expect(sql).toContain("WHERE id = $2");
    expect(sql).not.toContain("workspace_id = $");
    expect(params).toEqual(['[{"key":"score"}]', "survey-1"]);
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("survey-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { name: "x" })).resolves.toBeNull();
  });

  it("reports whether a survey was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "survey-1" }] });
    await expect(deleteSurvey("survey-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM surveys WHERE id = $1 RETURNING id",
      ["survey-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteSurvey("missing")).resolves.toBe(false);
  });
});
