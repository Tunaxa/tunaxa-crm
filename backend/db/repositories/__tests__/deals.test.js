import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as deals from "../deals.js";

const { create, findAll, findById, getPipelineSummary, update } = deals;
const deleteDeal = deals.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("deals repository", () => {
  it("lists deals with default pagination and total pages", async () => {
    const data = [{ id: "deal-1", title: "Expansion" }];
    setFindAllResult(21, data);

    const result = await findAll();

    expect(result).toEqual({
      data,
      total: 21,
      page: 1,
      limit: 20,
      totalPages: 2,
    });
    expect(pg.query).toHaveBeenCalledTimes(2);
    expect(pg.query.mock.calls[0][0]).toContain(
      "SELECT COUNT(*)::int AS total",
    );
    expect(pg.query.mock.calls[0][1]).toEqual([]);
    expect(pg.query.mock.calls[1][0]).toContain("SELECT *");
    expect(pg.query.mock.calls[1][0]).toContain(
      "ORDER BY created_at DESC",
    );
    expect(pg.query.mock.calls[1][1]).toEqual([20, 0]);
  });

  it("validates pagination and caps the limit at 100", async () => {
    await expect(findAll({ page: 0 })).rejects.toThrow(
      "page must be a positive integer",
    );
    await expect(findAll({ page: 1.5 })).rejects.toThrow(
      "page must be a positive integer",
    );
    await expect(findAll({ limit: 0 })).rejects.toThrow(
      "limit must be a positive integer",
    );
    await expect(findAll({ limit: 2.5 })).rejects.toThrow(
      "limit must be a positive integer",
    );

    setFindAllResult(0);
    const result = await findAll({ page: 3, limit: 250 });

    expect(result.page).toBe(3);
    expect(result.limit).toBe(100);
    expect(pg.query.mock.calls[1][1]).toEqual([100, 200]);
  });

  it("searches deal title and stage with parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "deal-1" }]);

    await findAll({ q: "proposal" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    const [dataSql, dataParams] = pg.query.mock.calls[1];
    expect(countSql).toContain("title ILIKE $1");
    expect(countSql).toContain("stage ILIKE $1");
    expect(countParams).toEqual(["%proposal%"]);
    expect(dataSql).toContain("LIMIT $2 OFFSET $3");
    expect(dataParams).toEqual(["%proposal%", 20, 0]);
  });

  it("allows every whitelisted deal sort and rejects malformed sorts", async () => {
    const sortColumns = [
      "created_at",
      "updated_at",
      "title",
      "value",
      "stage",
      "expected_close_date",
    ];
    for (const column of sortColumns) {
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:asc` });
      const dataSql = pg.query.mock.calls[pg.query.mock.calls.length - 1][0];
      expect(dataSql).toContain(`ORDER BY ${column} ASC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "stage:desc; DROP TABLE deals" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds a deal by id and returns null when absent", async () => {
    const record = { id: "deal-1", title: "Expansion" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("deal-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM deals WHERE id = $1",
      ["deal-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("creates a deal with parameterized fields", async () => {
    const data = {
      workspace_id: "workspace-1",
      contact_id: "contact-1",
      company_id: "company-1",
      owner_id: "user-1",
      title: "Expansion",
      value: 1250.5,
      stage: "Proposal",
      expected_close_date: "2026-12-31",
      custom_fields: { priority: "high" },
    };
    const record = { id: "deal-1", ...data };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(create(data)).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO deals");
    expect(sql).toContain("RETURNING *");
    expect(params).toEqual([
      data.workspace_id,
      data.contact_id,
      data.company_id,
      data.owner_id,
      data.title,
      data.value,
      data.stage,
      data.expected_close_date,
      data.custom_fields,
    ]);
  });

  it("updates only whitelisted deal fields and appends the id", async () => {
    const record = { id: "deal-1", stage: "Won" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("deal-1", {
      stage: "Won",
      value: 2000,
      workspace_id: "ignored",
      unknown: "ignored",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("value = $1, stage = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(sql).not.toContain("workspace_id = $");
    expect(sql).not.toContain("unknown = $");
    expect(params).toEqual([2000, "Won", "deal-1"]);
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("deal-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { stage: "Won" })).resolves.toBeNull();
  });

  it("reports whether a deal was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "deal-1" }] });
    await expect(deleteDeal("deal-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM deals WHERE id = $1 RETURNING id",
      ["deal-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteDeal("missing")).resolves.toBe(false);
  });

  it("returns a workspace-scoped pipeline summary grouped by stage", async () => {
    const rows = [
      { stage: "new", count: 2, total_value: "1500.00" },
      { stage: "won", count: 1, total_value: "3000.00" },
    ];
    pg.query.mockResolvedValueOnce({ rows });

    await expect(getPipelineSummary({ workspace_id: "workspace-1" })).resolves.toEqual(
      rows,
    );
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("COUNT(*)::int AS count");
    expect(sql).toContain("COALESCE(SUM(value), 0) AS total_value");
    expect(sql).toContain("WHERE workspace_id = $1");
    expect(sql).toContain("GROUP BY stage");
    expect(params).toEqual(["workspace-1"]);
  });

  it("supports an unfiltered pipeline summary when workspace is omitted", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await expect(getPipelineSummary()).resolves.toEqual([]);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).not.toContain("WHERE workspace_id");
    expect(params).toEqual([]);
  });
});
