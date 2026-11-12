import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as quotes from "../quotes.js";

const { create, findAll, findById, update } = quotes;
const deleteQuote = quotes.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("quotes repository", () => {
  it("lists quotes with default pagination and total pages", async () => {
    const data = [{ id: "quote-1", title: "Acme rollout" }];
    setFindAllResult(21, data);

    const result = await findAll();

    expect(result).toEqual({ data, total: 21, page: 1, limit: 20, totalPages: 2 });
    expect(pg.query.mock.calls[0][0]).toContain("FROM quotes");
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

  it("searches title, quote number, status and notes with a parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "quote-1" }]);

    await findAll({ q: "acme" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("title ILIKE $1");
    expect(countSql).toContain("quote_number ILIKE $1");
    expect(countSql).toContain("status ILIKE $1");
    expect(countSql).toContain("notes ILIKE $1");
    expect(countParams).toEqual(["%acme%"]);
  });

  it("filters on the exact status, deal, company and contact pointers", async () => {
    setFindAllResult(1, [{ id: "quote-1" }]);

    await findAll({
      status: "Sent",
      deal_id: "deal-1",
      company_id: "company-1",
      contact_id: "contact-1",
    });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("LOWER(COALESCE(status, '')) = $1");
    expect(countSql).toContain("LOWER(COALESCE(deal_id, '')) = $2");
    expect(countSql).toContain("LOWER(COALESCE(company_id, '')) = $3");
    expect(countSql).toContain("LOWER(COALESCE(contact_id, '')) = $4");
    expect(countParams).toEqual(["sent", "deal-1", "company-1", "contact-1"]);
  });

  it("combines search and status with independent parameters", async () => {
    setFindAllResult(1, [{ id: "quote-1" }]);

    await findAll({ q: "acme", status: "sent" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("title ILIKE $1");
    expect(countSql).toContain("LOWER(COALESCE(status, '')) = $2");
    expect(countParams).toEqual(["%acme%", "sent"]);
    expect(pg.query.mock.calls[1][1]).toEqual(["%acme%", "sent", 20, 0]);
  });

  it("ignores blank filters", async () => {
    setFindAllResult(0);

    await findAll({ status: "  ", deal_id: "" });

    expect(pg.query.mock.calls[0][0]).not.toContain("COALESCE(status");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("allows every whitelisted quote sort and rejects malformed sorts", async () => {
    for (const column of [
      "created_at",
      "updated_at",
      "title",
      "quote_number",
      "status",
      "total",
      "expiration_date",
    ]) {
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:asc` });
      const dataSql = pg.query.mock.calls[pg.query.mock.calls.length - 1][0];
      expect(dataSql).toContain(`ORDER BY ${column} ASC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "status:desc; DROP TABLE quotes" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds a quote by id and returns null when absent", async () => {
    const record = { id: "quote-1", title: "Acme rollout" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("quote-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM quotes WHERE id = $1",
      ["quote-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("creates a quote with parameterized fields", async () => {
    const data = {
      workspace_id: "workspace-1",
      title: "Acme rollout",
      quote_number: "Q-1001",
      deal_id: "deal-1",
      company_id: "company-1",
      contact_id: "contact-1",
      status: "Draft",
      subtotal: 1000,
      discount: 100,
      tax: 150,
      total: 1050,
      expiration_date: "2026-12-31T00:00:00.000Z",
      items: JSON.stringify([{ sku: "ST-1", qty: 2 }]),
      notes: "Net 30",
      custom_fields: { customerEmail: "cust@acme.com" },
    };
    const record = { id: "quote-1", ...data };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(create(data)).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO quotes");
    expect(sql).toContain("RETURNING *");
    expect(sql).toContain("$15");
    expect(params).toEqual([
      data.workspace_id,
      data.title,
      data.quote_number,
      data.deal_id,
      data.company_id,
      data.contact_id,
      data.status,
      data.subtotal,
      data.discount,
      data.tax,
      data.total,
      data.expiration_date,
      data.items,
      data.notes,
      data.custom_fields,
    ]);
  });

  it("defaults items to an empty array so the NOT NULL column is satisfied", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ title: "Acme rollout" });

    expect(pg.query.mock.calls[0][1][12]).toBe("[]");
  });

  it("updates only whitelisted quote fields and appends the id", async () => {
    const record = { id: "quote-1", status: "Sent" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("quote-1", {
      status: "Sent",
      total: 1050,
      workspace_id: "ignored",
      customerEmail: "cust@acme.com",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("status = $1, total = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(sql).not.toContain("workspace_id = $");
    expect(sql).not.toContain("customerEmail = $");
    expect(params).toEqual(["Sent", 1050, "quote-1"]);
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("quote-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { status: "Sent" })).resolves.toBeNull();
  });

  it("reports whether a quote was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "quote-1" }] });
    await expect(deleteQuote("quote-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM quotes WHERE id = $1 RETURNING id",
      ["quote-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteQuote("missing")).resolves.toBe(false);
  });
});
