import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as contracts from "../contracts.js";

const { create, findAll, findById, update } = contracts;
const deleteContract = contracts.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("contracts repository", () => {
  it("lists contracts with default pagination and total pages", async () => {
    const data = [{ id: "contract-1", title: "Acme MSA" }];
    setFindAllResult(21, data);

    const result = await findAll();

    expect(result).toEqual({ data, total: 21, page: 1, limit: 20, totalPages: 2 });
    expect(pg.query.mock.calls[0][0]).toContain("FROM contracts");
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

  it("searches title, contract number, status and terms with a parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "contract-1" }]);

    await findAll({ q: "acme" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("title ILIKE $1");
    expect(countSql).toContain("contract_number ILIKE $1");
    expect(countSql).toContain("status ILIKE $1");
    expect(countSql).toContain("terms ILIKE $1");
    expect(countParams).toEqual(["%acme%"]);
  });

  it("filters on the exact status, deal, company and quote pointers", async () => {
    setFindAllResult(1, [{ id: "contract-1" }]);

    await findAll({
      status: "Active",
      deal_id: "deal-1",
      company_id: "company-1",
      quote_id: "quote-1",
    });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("LOWER(COALESCE(status, '')) = $1");
    expect(countSql).toContain("LOWER(COALESCE(deal_id, '')) = $2");
    expect(countSql).toContain("LOWER(COALESCE(company_id, '')) = $3");
    expect(countSql).toContain("LOWER(COALESCE(quote_id, '')) = $4");
    expect(countParams).toEqual(["active", "deal-1", "company-1", "quote-1"]);
  });

  it("combines search and status with independent parameters", async () => {
    setFindAllResult(1, [{ id: "contract-1" }]);

    await findAll({ q: "acme", status: "active" });

    expect(pg.query.mock.calls[0][1]).toEqual(["%acme%", "active"]);
    expect(pg.query.mock.calls[1][1]).toEqual(["%acme%", "active", 20, 0]);
  });

  it("ignores blank filters", async () => {
    setFindAllResult(0);

    await findAll({ status: "  ", quote_id: "" });

    expect(pg.query.mock.calls[0][0]).not.toContain("COALESCE(status");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("allows every whitelisted contract sort and rejects malformed sorts", async () => {
    for (const column of [
      "created_at",
      "updated_at",
      "title",
      "contract_number",
      "status",
      "value",
      "start_date",
      "end_date",
    ]) {
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:asc` });
      const dataSql = pg.query.mock.calls[pg.query.mock.calls.length - 1][0];
      expect(dataSql).toContain(`ORDER BY ${column} ASC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "value:desc; DROP TABLE contracts" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds a contract by id and returns null when absent", async () => {
    const record = { id: "contract-1", title: "Acme MSA" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("contract-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM contracts WHERE id = $1",
      ["contract-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("creates a contract with parameterized fields", async () => {
    const data = {
      workspace_id: "workspace-1",
      title: "Acme MSA",
      contract_number: "C-1001",
      deal_id: "deal-1",
      company_id: "company-1",
      contact_id: "contact-1",
      quote_id: "quote-1",
      status: "Active",
      value: 1500,
      start_date: "2026-01-01T00:00:00.000Z",
      end_date: "2027-01-01T00:00:00.000Z",
      terms: "Net 30",
      custom_fields: { customerEmail: "cust@acme.com" },
    };
    const record = { id: "contract-1", ...data };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(create(data)).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO contracts");
    expect(sql).toContain("RETURNING *");
    expect(sql).toContain("$13");
    expect(params).toEqual([
      data.workspace_id,
      data.title,
      data.contract_number,
      data.deal_id,
      data.company_id,
      data.contact_id,
      data.quote_id,
      data.status,
      data.value,
      data.start_date,
      data.end_date,
      data.terms,
      data.custom_fields,
    ]);
  });

  it("passes the contract value through uncoerced so DOUBLE PRECISION stays a number", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ title: "Acme MSA", value: 1500.5 });

    expect(pg.query.mock.calls[0][1][8]).toBe(1500.5);
  });

  it("updates only whitelisted contract fields and appends the id", async () => {
    const record = { id: "contract-1", status: "Active" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("contract-1", {
      status: "Active",
      value: 2000,
      quote_id: "quote-2",
      workspace_id: "ignored",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("quote_id = $1, status = $2, value = $3");
    expect(sql).toContain("WHERE id = $4");
    expect(sql).not.toContain("workspace_id = $");
    expect(params).toEqual(["quote-2", "Active", 2000, "contract-1"]);
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("contract-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { status: "Active" })).resolves.toBeNull();
  });

  it("reports whether a contract was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "contract-1" }] });
    await expect(deleteContract("contract-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM contracts WHERE id = $1 RETURNING id",
      ["contract-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteContract("missing")).resolves.toBe(false);
  });
});
