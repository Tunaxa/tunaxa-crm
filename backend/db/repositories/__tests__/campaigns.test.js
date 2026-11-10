import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as campaigns from "../campaigns.js";

const { create, findAll, findById, update } = campaigns;
const deleteCampaign = campaigns.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("campaigns repository", () => {
  it("lists campaigns with default pagination and total pages", async () => {
    const data = [{ id: "campaign-1" }];
    setFindAllResult(21, data);

    await expect(findAll()).resolves.toEqual({
      data,
      total: 21,
      page: 1,
      limit: 20,
      totalPages: 2,
    });
    expect(pg.query.mock.calls[0][0]).toContain("FROM campaigns");
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
    const result = await findAll({ page: 3, limit: 250 });

    expect(result.limit).toBe(100);
    expect(pg.query.mock.calls[1][1]).toEqual([100, 200]);
  });

  it("searches name, description, status and channel with a parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "campaign-1" }]);

    await findAll({ q: "spring" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("name ILIKE $1");
    expect(countSql).toContain("description ILIKE $1");
    expect(countSql).toContain("status ILIKE $1");
    expect(countSql).toContain("channel ILIKE $1");
    expect(countParams).toEqual(["%spring%"]);
  });

  // status and channel are single stored values, so they are compared exactly.
  // A fuzzy match would return "Active-ish" for a filter of "active".
  it("filters status and channel exactly, case-insensitively", async () => {
    setFindAllResult(1, [{ id: "campaign-1" }]);

    await findAll({ status: "Active", channel: "Email" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("LOWER(COALESCE(status, '')) = $1");
    expect(countSql).toContain("LOWER(COALESCE(channel, '')) = $2");
    expect(countSql).not.toContain("status ILIKE $1");
    expect(countParams).toEqual(["active", "email"]);
  });

  it("combines search, status and channel with independent parameters", async () => {
    setFindAllResult(1, [{ id: "campaign-1" }]);

    await findAll({ q: "spring", status: "Active", channel: "Email" });

    expect(pg.query.mock.calls[0][1]).toEqual([
      "%spring%",
      "active",
      "email",
    ]);
    expect(pg.query.mock.calls[1][1]).toEqual([
      "%spring%",
      "active",
      "email",
      20,
      0,
    ]);
  });

  it("ignores blank filters", async () => {
    setFindAllResult(0);

    await findAll({ q: "   ", status: "", channel: "  " });

    expect(pg.query.mock.calls[0][0]).not.toContain("COALESCE(status");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("allows every whitelisted campaign sort and rejects malformed sorts", async () => {
    for (const column of [
      "created_at",
      "updated_at",
      "name",
      "status",
      "channel",
      "budget",
      "start_date",
      "end_date",
    ]) {
      pg.query.mockReset();
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:asc` });
      const dataSql = pg.query.mock.calls[1][0];
      expect(dataSql).toContain(`ORDER BY ${column} ASC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "name:desc; DROP TABLE campaigns" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds a campaign by id and returns null when absent", async () => {
    const record = { id: "campaign-1" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("campaign-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM campaigns WHERE id = $1",
      ["campaign-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("serializes object jsonb columns and leaves numerics uncoerced", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({
      workspace_id: "workspace-1",
      name: "Spring",
      channel: "Email",
      status: "Active",
      budget: 1000.5,
      metrics: { opens: 12 },
      custom_fields: { owner: "ops" },
    });

    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO campaigns");
    expect(sql).toContain("RETURNING *");
    // DOUBLE PRECISION columns must stay numbers, or modules.js sums strings.
    expect(params[5]).toBe(1000.5);
    expect(params[12]).toBe('{"opens":12}');
    expect(params[13]).toBe('{"owner":"ops"}');
  });

  it("defaults missing jsonb columns to an empty object", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ name: "Spring" });

    const params = pg.query.mock.calls[0][1];
    expect(params[12]).toBe("{}");
    expect(params[13]).toBe("{}");
  });

  it("updates only whitelisted campaign fields and appends the id", async () => {
    const record = { id: "campaign-1", budget: 2000 };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("campaign-1", {
      budget: 2000,
      channel: "SMS",
      workspace_id: "ignored",
      id: "hacked",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    // Assignments follow UPDATE_FIELDS, not the order of the input object.
    expect(sql).toContain("channel = $1, budget = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(sql).not.toContain("workspace_id = $");
    // A client-supplied id must not become an assignment. WHERE id is expected,
    // so the check is scoped to the SET clause.
    const setClause = sql.slice(sql.indexOf("SET"), sql.indexOf("WHERE"));
    expect(setClause).not.toContain("id = $");
    expect(params).toEqual(["SMS", 2000, "campaign-1"]);
  });

  it("serializes jsonb fields on update", async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: "campaign-1" }] });

    await update("campaign-1", { metrics: { clicks: 3 } });

    expect(pg.query.mock.calls[0][1][0]).toBe('{"clicks":3}');
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("campaign-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { budget: 1 })).resolves.toBeNull();
  });

  it("reports whether a campaign was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "campaign-1" }] });
    await expect(deleteCampaign("campaign-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM campaigns WHERE id = $1 RETURNING id",
      ["campaign-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteCampaign("missing")).resolves.toBe(false);
  });
});
