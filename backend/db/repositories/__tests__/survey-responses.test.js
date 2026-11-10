import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as surveyResponses from "../survey-responses.js";

const { create, findAll, findById, update } = surveyResponses;
const deleteResponse = surveyResponses.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("survey_responses repository", () => {
  it("lists responses with default pagination and total pages", async () => {
    const data = [{ id: "response-1" }];
    setFindAllResult(21, data);

    await expect(findAll()).resolves.toEqual({
      data,
      total: 21,
      page: 1,
      limit: 20,
      totalPages: 2,
    });
    expect(pg.query.mock.calls[0][0]).toContain("FROM survey_responses");
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

  it("searches survey, respondent, respondent_email and comment", async () => {
    setFindAllResult(1, [{ id: "response-1" }]);

    await findAll({ q: "jane" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("survey ILIKE $1");
    expect(countSql).toContain("respondent ILIKE $1");
    expect(countSql).toContain("respondent_email ILIKE $1");
    expect(countSql).toContain("comment ILIKE $1");
    expect(countParams).toEqual(["%jane%"]);
  });

  // `survey` holds a survey *name* in the legacy store, not an id, so this is a
  // case-insensitive name match rather than a foreign key lookup.
  it("filters by survey name and respondent email, case-insensitively", async () => {
    setFindAllResult(1, [{ id: "response-1" }]);

    await findAll({ survey: "NPS", respondentEmail: "Jane@Example.com" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("LOWER(COALESCE(survey, '')) = $1");
    expect(countSql).toContain("LOWER(COALESCE(respondent_email, '')) = $2");
    expect(countParams).toEqual(["nps", "jane@example.com"]);
  });

  it("ignores blank filters", async () => {
    setFindAllResult(0);

    await findAll({ q: "  ", survey: "", respondentEmail: "" });

    expect(pg.query.mock.calls[0][0]).not.toContain("COALESCE(survey");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("allows every whitelisted sort and rejects malformed sorts", async () => {
    for (const column of [
      "created_at",
      "updated_at",
      "submitted_at",
      "survey",
      "respondent",
      "score",
    ]) {
      pg.query.mockReset();
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:desc` });
      expect(pg.query.mock.calls[1][0]).toContain(`ORDER BY ${column} DESC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "score; DROP TABLE survey_responses" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds a response by id and returns null when absent", async () => {
    const record = { id: "response-1" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("response-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM survey_responses WHERE id = $1",
      ["response-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("serializes the responses object and keeps the score a number", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({
      survey: "NPS",
      score: 10,
      responses: { score: 10, why: "great" },
    });

    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO survey_responses");
    expect(params[5]).toBe(10);
    expect(params[7]).toBe('{"score":10,"why":"great"}');
  });

  it("defaults the responses bag to an empty object", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ survey: "NPS" });

    expect(pg.query.mock.calls[0][1][7]).toBe("{}");
  });

  it("normalizes an empty-string submitted_at to null", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ survey: "NPS", submitted_at: "" });

    expect(pg.query.mock.calls[0][1][8]).toBeNull();
  });

  it("passes a real submitted_at through", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ survey: "NPS", submitted_at: "2026-03-01T10:00:00.000Z" });

    expect(pg.query.mock.calls[0][1][8]).toBe("2026-03-01T10:00:00.000Z");
  });

  it("updates only whitelisted fields and normalizes submitted_at", async () => {
    const record = { id: "response-1" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("response-1", {
      submitted_at: "",
      responses: { score: 7 },
      workspace_id: "ignored",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("responses = $1, submitted_at = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(sql).not.toContain("workspace_id = $");
    expect(params).toEqual(['{"score":7}', null, "response-1"]);
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("response-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { score: 1 })).resolves.toBeNull();
  });

  it("reports whether a response was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "response-1" }] });
    await expect(deleteResponse("response-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM survey_responses WHERE id = $1 RETURNING id",
      ["response-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteResponse("missing")).resolves.toBe(false);
  });
});
