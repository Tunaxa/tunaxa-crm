import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as orders from "../orders.js";

const { create, findAll, findById, update } = orders;
const deleteOrder = orders.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("orders repository", () => {
  it("lists orders with default pagination and total pages", async () => {
    const data = [{ id: "order-1", order_number: "SO-1" }];
    setFindAllResult(21, data);

    const result = await findAll();

    expect(result).toEqual({ data, total: 21, page: 1, limit: 20, totalPages: 2 });
    expect(pg.query.mock.calls[0][0]).toContain("FROM orders");
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

  it("searches order number and status with a parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "order-1" }]);

    await findAll({ q: "SO-1" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("order_number ILIKE $1");
    expect(countSql).toContain("status ILIKE $1");
    expect(countParams).toEqual(["%SO-1%"]);
  });

  it("filters on the exact status, deal, quote and contract pointers", async () => {
    setFindAllResult(1, [{ id: "order-1" }]);

    await findAll({
      status: "Pending",
      deal_id: "deal-1",
      quote_id: "quote-1",
      contract_id: "contract-1",
    });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("LOWER(COALESCE(status, '')) = $1");
    expect(countSql).toContain("LOWER(COALESCE(deal_id, '')) = $2");
    expect(countSql).toContain("LOWER(COALESCE(quote_id, '')) = $3");
    expect(countSql).toContain("LOWER(COALESCE(contract_id, '')) = $4");
    expect(countParams).toEqual(["pending", "deal-1", "quote-1", "contract-1"]);
  });

  it("combines search and status with independent parameters", async () => {
    setFindAllResult(1, [{ id: "order-1" }]);

    await findAll({ q: "acme", status: "pending" });

    expect(pg.query.mock.calls[0][1]).toEqual(["%acme%", "pending"]);
    expect(pg.query.mock.calls[1][1]).toEqual(["%acme%", "pending", 20, 0]);
  });

  it("ignores blank filters", async () => {
    setFindAllResult(0);

    await findAll({ status: "  ", contract_id: "" });

    expect(pg.query.mock.calls[0][0]).not.toContain("COALESCE(status");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("allows every whitelisted order sort and rejects malformed sorts", async () => {
    for (const column of ["created_at", "updated_at", "order_number", "status", "total"]) {
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:asc` });
      const dataSql = pg.query.mock.calls[pg.query.mock.calls.length - 1][0];
      expect(dataSql).toContain(`ORDER BY ${column} ASC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "total:desc; DROP TABLE orders" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds an order by id and returns null when absent", async () => {
    const record = { id: "order-1", order_number: "SO-1" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("order-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM orders WHERE id = $1",
      ["order-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("creates an order with parameterized fields", async () => {
    const data = {
      workspace_id: "workspace-1",
      order_number: "SO-1",
      deal_id: "deal-1",
      company_id: "company-1",
      contact_id: "contact-1",
      quote_id: "quote-1",
      contract_id: "contract-1",
      status: "Pending",
      total: 1500,
      items: JSON.stringify([{ sku: "ST-1", qty: 2 }]),
      custom_fields: { customerEmail: "cust@acme.com" },
    };
    const record = { id: "order-1", ...data };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(create(data)).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO orders");
    expect(sql).toContain("RETURNING *");
    expect(sql).toContain("$11");
    expect(params).toEqual([
      data.workspace_id,
      data.order_number,
      data.deal_id,
      data.company_id,
      data.contact_id,
      data.quote_id,
      data.contract_id,
      data.status,
      data.total,
      data.items,
      data.custom_fields,
    ]);
  });

  it("defaults items to an empty array so the NOT NULL column is satisfied", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ order_number: "SO-1" });

    // node-postgres binds a raw array as a Postgres array literal, which jsonb
    // rejects with 22P02, so the repository serializes it first.
    expect(pg.query.mock.calls[0][1][9]).toBe("[]");
  });

  it("passes the order total through uncoerced so DOUBLE PRECISION stays a number", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ order_number: "SO-1", total: 1500.5 });

    expect(pg.query.mock.calls[0][1][8]).toBe(1500.5);
  });

  it("updates only whitelisted order fields and appends the id", async () => {
    const record = { id: "order-1", status: "Paid" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("order-1", {
      status: "Paid",
      total: 1500,
      workspace_id: "ignored",
      customerEmail: "cust@acme.com",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("status = $1, total = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(sql).not.toContain("workspace_id = $");
    expect(sql).not.toContain("customerEmail = $");
    expect(params).toEqual(["Paid", 1500, "order-1"]);
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("order-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { status: "Paid" })).resolves.toBeNull();
  });

  it("serializes items to JSON so jsonb does not reject a Postgres array literal", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ order_number: "SO-1", items: ["x1"] });

    expect(pg.query.mock.calls[0][1][9]).toBe('["x1"]');
  });

  it("serializes items on update too", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await update("order-1", { items: ["x1", "x2"] });

    expect(pg.query.mock.calls[0][1][0]).toBe('["x1","x2"]');
  });

  it("passes an already-serialized items string through without double-encoding", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ order_number: "SO-1", items: '["x1"]' });

    expect(pg.query.mock.calls[0][1][9]).toBe('["x1"]');
  });

  it("reports whether an order was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "order-1" }] });
    await expect(deleteOrder("order-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM orders WHERE id = $1 RETURNING id",
      ["order-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteOrder("missing")).resolves.toBe(false);
  });
});
