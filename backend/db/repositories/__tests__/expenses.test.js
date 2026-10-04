import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as expenses from "../expenses.js";

const { create, findAll, findById, getExpenseSummary, update } = expenses;
const deleteExpense = expenses.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("expenses repository", () => {
  it("lists expenses with default pagination and total pages", async () => {
    const data = [{ id: "expense-1", title: "Cloud hosting" }];
    setFindAllResult(21, data);

    const result = await findAll();

    expect(result).toEqual({ data, total: 21, page: 1, limit: 20, totalPages: 2 });
    expect(pg.query.mock.calls[0][0]).toContain("FROM expenses");
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

  it("searches title, vendor, notes and category with a parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "expense-1" }]);

    await findAll({ q: "acme" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("title ILIKE $1");
    expect(countSql).toContain("vendor ILIKE $1");
    expect(countSql).toContain("notes ILIKE $1");
    expect(countSql).toContain("category ILIKE $1");
    expect(countParams).toEqual(["%acme%"]);
  });

  it("filters on the exact category, deal and company pointers", async () => {
    setFindAllResult(1, [{ id: "expense-1" }]);

    await findAll({ category: "Infra", deal_id: "deal-1", company_id: "company-1" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("LOWER(COALESCE(category, '')) = $1");
    expect(countSql).toContain("LOWER(COALESCE(deal_id, '')) = $2");
    expect(countSql).toContain("LOWER(COALESCE(company_id, '')) = $3");
    expect(countParams).toEqual(["infra", "deal-1", "company-1"]);
  });

  it("combines search and category with independent parameters", async () => {
    setFindAllResult(1, [{ id: "expense-1" }]);

    await findAll({ q: "acme", category: "infra" });

    expect(pg.query.mock.calls[0][1]).toEqual(["%acme%", "infra"]);
    expect(pg.query.mock.calls[1][1]).toEqual(["%acme%", "infra", 20, 0]);
  });

  it("ignores blank filters", async () => {
    setFindAllResult(0);

    await findAll({ category: "  ", deal_id: "" });

    expect(pg.query.mock.calls[0][0]).not.toContain("COALESCE(category");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("allows every whitelisted expense sort and rejects malformed sorts", async () => {
    for (const column of [
      "created_at",
      "updated_at",
      "title",
      "category",
      "amount",
      "date",
      "vendor",
    ]) {
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:asc` });
      const dataSql = pg.query.mock.calls[pg.query.mock.calls.length - 1][0];
      expect(dataSql).toContain(`ORDER BY ${column} ASC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "amount:desc; DROP TABLE expenses" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds an expense by id and returns null when absent", async () => {
    const record = { id: "expense-1", title: "Cloud hosting" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("expense-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM expenses WHERE id = $1",
      ["expense-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("creates an expense with parameterized fields", async () => {
    const data = {
      workspace_id: "workspace-1",
      title: "Cloud hosting",
      category: "Infrastructure",
      amount: 250.4,
      date: "2026-03-15T00:00:00.000Z",
      vendor: "Acme Cloud",
      deal_id: "deal-1",
      company_id: "company-1",
      user_id: "user-1",
      notes: "March",
      custom_fields: { receipt: "receipt-1.pdf" },
    };
    const record = { id: "expense-1", ...data };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(create(data)).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO expenses");
    expect(sql).toContain("RETURNING *");
    expect(sql).toContain("$11");
    expect(params).toEqual([
      data.workspace_id,
      data.title,
      data.category,
      data.amount,
      data.date,
      data.vendor,
      data.deal_id,
      data.company_id,
      data.user_id,
      data.notes,
      data.custom_fields,
    ]);
  });

  it("passes the amount through uncoerced so DOUBLE PRECISION stays a number", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ title: "Cloud hosting", amount: 250.4 });

    expect(pg.query.mock.calls[0][1][3]).toBe(250.4);
  });

  it("updates only whitelisted expense fields and appends the id", async () => {
    const record = { id: "expense-1", amount: 300 };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("expense-1", {
      amount: 300,
      vendor: "New Vendor",
      workspace_id: "ignored",
      receipt: "r.pdf",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("amount = $1, vendor = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(sql).not.toContain("workspace_id = $");
    expect(sql).not.toContain("receipt = $");
    expect(params).toEqual([300, "New Vendor", "expense-1"]);
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("expense-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { amount: 1 })).resolves.toBeNull();
  });

  it("reports whether an expense was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "expense-1" }] });
    await expect(deleteExpense("expense-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM expenses WHERE id = $1 RETURNING id",
      ["expense-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteExpense("missing")).resolves.toBe(false);
  });

  it("aggregates spend grouped by category, defaulting a blank category", async () => {
    const rows = [{ category: "Infrastructure", total: 250.4 }];
    pg.query.mockResolvedValueOnce({ rows });

    await expect(getExpenseSummary()).resolves.toEqual(rows);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("COALESCE(category, 'Uncategorized')");
    expect(sql).toContain("COALESCE(SUM(amount), 0) AS total");
    expect(params).toEqual([]);
  });
});
