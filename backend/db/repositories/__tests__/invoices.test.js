import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as invoices from "../invoices.js";

const { create, findAll, findById, getFinanceSummary, update } = invoices;
const deleteInvoice = invoices.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("invoices repository", () => {
  it("lists invoices with default pagination and total pages", async () => {
    const data = [{ id: "inv-1", invoice_number: "INV-1" }];
    setFindAllResult(21, data);

    const result = await findAll();

    expect(result).toEqual({ data, total: 21, page: 1, limit: 20, totalPages: 2 });
    expect(pg.query.mock.calls[0][0]).toContain("FROM invoices");
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

  it("searches invoice number and status with a parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "inv-1" }]);

    await findAll({ q: "INV" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("invoice_number ILIKE $1");
    expect(countSql).toContain("status ILIKE $1");
    expect(countParams).toEqual(["%INV%"]);
  });

  it("filters on the exact status, order, deal and company pointers", async () => {
    setFindAllResult(1, [{ id: "inv-1" }]);

    await findAll({
      status: "Paid",
      order_id: "order-1",
      deal_id: "deal-1",
      company_id: "company-1",
    });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("LOWER(COALESCE(status, '')) = $1");
    expect(countSql).toContain("LOWER(COALESCE(order_id, '')) = $2");
    expect(countSql).toContain("LOWER(COALESCE(deal_id, '')) = $3");
    expect(countSql).toContain("LOWER(COALESCE(company_id, '')) = $4");
    expect(countParams).toEqual(["paid", "order-1", "deal-1", "company-1"]);
  });

  it("combines search and status with independent parameters", async () => {
    setFindAllResult(1, [{ id: "inv-1" }]);

    await findAll({ q: "acme", status: "paid" });

    expect(pg.query.mock.calls[0][1]).toEqual(["%acme%", "paid"]);
    expect(pg.query.mock.calls[1][1]).toEqual(["%acme%", "paid", 20, 0]);
  });

  it("ignores blank filters", async () => {
    setFindAllResult(0);

    await findAll({ status: "  ", order_id: "" });

    expect(pg.query.mock.calls[0][0]).not.toContain("COALESCE(status");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("allows every whitelisted invoice sort and rejects malformed sorts", async () => {
    for (const column of [
      "created_at",
      "updated_at",
      "invoice_number",
      "status",
      "total",
      "due_date",
      "paid_at",
    ]) {
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:asc` });
      const dataSql = pg.query.mock.calls[pg.query.mock.calls.length - 1][0];
      expect(dataSql).toContain(`ORDER BY ${column} ASC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "status:desc; DROP TABLE invoices" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds an invoice by id and returns null when absent", async () => {
    const record = { id: "inv-1", invoice_number: "INV-1" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("inv-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM invoices WHERE id = $1",
      ["inv-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("creates an invoice with parameterized fields", async () => {
    const data = {
      workspace_id: "workspace-1",
      invoice_number: "INV-P",
      order_id: "order-1",
      deal_id: "deal-1",
      company_id: "company-1",
      contact_id: "contact-1",
      status: "Paid",
      total: 700,
      due_date: "2026-04-01T00:00:00.000Z",
      paid_at: "2026-03-20T08:00:00.000Z",
      items: JSON.stringify([{ sku: "ST-1" }]),
      custom_fields: { customerEmail: "cust@acme.com" },
    };
    const record = { id: "inv-1", ...data };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(create(data)).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO invoices");
    expect(sql).toContain("RETURNING *");
    expect(sql).toContain("$12");
    expect(params).toEqual([
      data.workspace_id,
      data.invoice_number,
      data.order_id,
      data.deal_id,
      data.company_id,
      data.contact_id,
      data.status,
      data.total,
      data.due_date,
      data.paid_at,
      data.items,
      data.custom_fields,
    ]);
  });

  it("defaults items to an empty array so the NOT NULL column is satisfied", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ invoice_number: "INV-P" });

    expect(pg.query.mock.calls[0][1][10]).toBe("[]");
  });

  it("passes the invoice total through uncoerced so DOUBLE PRECISION stays a number", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ invoice_number: "INV-P", total: 700.25 });

    expect(pg.query.mock.calls[0][1][7]).toBe(700.25);
  });

  it("updates only whitelisted invoice fields and appends the id", async () => {
    const record = { id: "inv-1", status: "Paid" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("inv-1", {
      status: "Paid",
      paid_at: "2026-03-20T08:00:00.000Z",
      workspace_id: "ignored",
      customerEmail: "cust@acme.com",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("status = $1, paid_at = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(sql).not.toContain("workspace_id = $");
    expect(sql).not.toContain("customerEmail = $");
    expect(params).toEqual(["Paid", "2026-03-20T08:00:00.000Z", "inv-1"]);
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("inv-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { status: "Paid" })).resolves.toBeNull();
  });

  it("reports whether an invoice was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "inv-1" }] });
    await expect(deleteInvoice("inv-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM invoices WHERE id = $1 RETURNING id",
      ["inv-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteInvoice("missing")).resolves.toBe(false);
  });

  it("aggregates issued, paid and outstanding totals for the finance summary", async () => {
    const row = { issued: 700, paid: 700, outstanding: 0 };
    pg.query.mockResolvedValueOnce({ rows: [row] });

    await expect(getFinanceSummary()).resolves.toBe(row);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("COALESCE(SUM(total), 0) AS issued");
    expect(sql).toContain("AS paid");
    expect(sql).toContain("AS outstanding");
    // The JS comparison is on lowercased status, so the filter is too.
    expect(sql).toContain("LOWER(COALESCE(status, '')) = 'paid'");
    expect(params).toEqual([]);
  });
});
