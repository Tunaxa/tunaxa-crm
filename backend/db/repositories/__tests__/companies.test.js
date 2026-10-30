import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as companies from "../companies.js";

const { create, findAll, findById, update } = companies;
const deleteCompany = companies.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("companies repository", () => {
  it("lists companies with default pagination and total pages", async () => {
    const data = [{ id: "company-1", name: "Acme" }];
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

  it("searches every company search column with a parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "company-1" }]);

    await findAll({ q: "acme" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    const [dataSql, dataParams] = pg.query.mock.calls[1];
    expect(countSql).toContain("name ILIKE $1");
    expect(countSql).toContain("domain ILIKE $1");
    expect(countSql).toContain("industry ILIKE $1");
    expect(countSql).toContain("website ILIKE $1");
    expect(countSql).toContain("country ILIKE $1");
    expect(countParams).toEqual(["%acme%"]);
    expect(dataSql).toContain("LIMIT $2 OFFSET $3");
    expect(dataParams).toEqual(["%acme%", 20, 0]);
  });

  it("treats a blank search term as no filter", async () => {
    setFindAllResult(0);

    await findAll({ q: "   " });

    expect(pg.query.mock.calls[0][0]).not.toContain("ILIKE");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("allows every whitelisted sort and rejects malformed sorts", async () => {
    const sortColumns = [
      "created_at",
      "updated_at",
      "name",
      "domain",
      "industry",
      "size",
      "employees",
    ];
    for (const column of sortColumns) {
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:asc` });
      const dataSql = pg.query.mock.calls[pg.query.mock.calls.length - 1][0];
      expect(dataSql).toContain(`ORDER BY ${column} ASC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "name:desc; DROP TABLE companies" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds a company by id and returns null when absent", async () => {
    const record = { id: "company-1", name: "Acme" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("company-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM companies WHERE id = $1",
      ["company-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("creates a company with parameterized fields", async () => {
    const data = {
      workspace_id: "workspace-1",
      name: "Acme",
      domain: "acme.example",
      industry: "Technology",
      website: "https://acme.example",
      country: "FR",
      size: "100-499",
      employees: 250,
      owner: "Test User",
      custom_fields: { region: "emea" },
    };
    const record = { id: "company-1", ...data };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(create(data)).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO companies");
    expect(sql).toContain("RETURNING *");
    expect(sql).toContain("$10");
    expect(params).toEqual([
      data.workspace_id,
      data.name,
      data.domain,
      data.industry,
      data.website,
      data.country,
      data.size,
      data.employees,
      data.owner,
      data.custom_fields,
    ]);
  });

  it("defaults custom_fields to an empty object on create", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ name: "Acme" });

    expect(pg.query.mock.calls[0][1].at(-1)).toEqual({});
  });

  it("updates only whitelisted company fields and appends the id", async () => {
    const record = { id: "company-1", name: "Acme Corp" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("company-1", {
      name: "Acme Corp",
      employees: 300,
      custom_fields: { verified: true },
      workspace_id: "ignored",
      unknown: "ignored",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain(
      "name = $1, employees = $2, custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $3::jsonb",
    );
    expect(sql).toContain("WHERE id = $4");
    expect(sql).not.toContain("workspace_id = $");
    expect(sql).not.toContain("unknown = $");
    expect(params).toEqual([
      "Acme Corp",
      300,
      '{"verified":true}',
      "company-1",
    ]);
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("company-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { name: "Acme" })).resolves.toBeNull();
  });

  it("reports whether a company was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "company-1" }] });
    await expect(deleteCompany("company-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM companies WHERE id = $1 RETURNING id",
      ["company-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteCompany("missing")).resolves.toBe(false);
  });
});
