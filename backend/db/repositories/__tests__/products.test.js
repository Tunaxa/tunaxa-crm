import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as products from "../products.js";

const { create, findAll, findById, update } = products;
const deleteProduct = products.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("products repository", () => {
  it("lists products with default pagination and total pages", async () => {
    const data = [{ id: "product-1", name: "Starter Plan" }];
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
    expect(pg.query.mock.calls[0][0]).toContain("SELECT COUNT(*)::int AS total");
    expect(pg.query.mock.calls[0][0]).toContain("FROM products");
    expect(pg.query.mock.calls[1][0]).toContain("ORDER BY created_at DESC");
    expect(pg.query.mock.calls[1][1]).toEqual([20, 0]);
  });

  it("validates pagination and caps the limit at 100", async () => {
    await expect(findAll({ page: 0 })).rejects.toThrow(
      "page must be a positive integer",
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

  it("searches name, sku, description and category with a parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "product-1" }]);

    await findAll({ q: "starter" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("name ILIKE $1");
    expect(countSql).toContain("sku ILIKE $1");
    expect(countSql).toContain("description ILIKE $1");
    expect(countSql).toContain("category ILIKE $1");
    expect(countParams).toEqual(["%starter%"]);
    expect(pg.query.mock.calls[1][1]).toEqual(["%starter%", 20, 0]);
  });

  it("filters on an exact category label", async () => {
    setFindAllResult(1, [{ id: "product-1" }]);

    await findAll({ category: "Infrastructure" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("LOWER(COALESCE(category, '')) = $1");
    expect(countParams).toEqual(["infrastructure"]);
  });

  it("combines search and category filters with independent parameters", async () => {
    setFindAllResult(1, [{ id: "product-1" }]);

    await findAll({ q: "acme", category: "infra" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("name ILIKE $1");
    expect(countSql).toContain("LOWER(COALESCE(category, '')) = $2");
    expect(countParams).toEqual(["%acme%", "infra"]);
  });

  it("ignores a blank category filter", async () => {
    setFindAllResult(0);

    await findAll({ category: "  " });

    expect(pg.query.mock.calls[0][0]).not.toContain("COALESCE(category");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("allows every whitelisted product sort and rejects malformed sorts", async () => {
    for (const column of ["created_at", "updated_at", "name", "sku", "category", "price"]) {
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:asc` });
      const dataSql = pg.query.mock.calls[pg.query.mock.calls.length - 1][0];
      expect(dataSql).toContain(`ORDER BY ${column} ASC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "name:desc; DROP TABLE products" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds a product by id and returns null when absent", async () => {
    const record = { id: "product-1", name: "Starter Plan" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("product-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM products WHERE id = $1",
      ["product-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("creates a product with parameterized fields", async () => {
    const data = {
      workspace_id: "workspace-1",
      name: "Starter Plan",
      sku: "ST-1",
      description: "Entry tier",
      price: 49.99,
      cost: 10,
      category: "Plans",
      active: true,
      custom_fields: { stock: 100 },
    };
    const record = { id: "product-1", ...data };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(create(data)).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO products");
    expect(sql).toContain("RETURNING *");
    expect(params).toEqual([
      data.workspace_id,
      data.name,
      data.sku,
      data.description,
      data.price,
      data.cost,
      data.category,
      data.active,
      data.custom_fields,
    ]);
  });

  it("leaves active null when unset so the column DEFAULT TRUE applies", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ name: "Starter Plan" });

    expect(pg.query.mock.calls[0][1][7]).toBeNull();
  });

  it("round-trips an explicit active false", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ name: "Retired", active: false });

    expect(pg.query.mock.calls[0][1][7]).toBe(false);
  });

  it("updates only whitelisted product fields and appends the id", async () => {
    const record = { id: "product-1", name: "Renamed" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("product-1", {
      name: "Renamed",
      price: 59.99,
      workspace_id: "ignored",
      stock: 100,
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("name = $1, price = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(sql).not.toContain("workspace_id = $");
    expect(sql).not.toContain("stock = $");
    expect(params).toEqual(["Renamed", 59.99, "product-1"]);
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("product-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { name: "x" })).resolves.toBeNull();
  });

  it("reports whether a product was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "product-1" }] });
    await expect(deleteProduct("product-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM products WHERE id = $1 RETURNING id",
      ["product-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteProduct("missing")).resolves.toBe(false);
  });
});
