import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as leads from "../leads.js";

const { create, findAll, findById, findByEmail, update } = leads;
const deleteLead = leads.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("leads repository", () => {
  it("lists leads with default pagination and total pages", async () => {
    const data = [{ id: "lead-1", first_name: "Ada" }];
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

  it("searches every lead search column with a parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "lead-1" }]);

    await findAll({ q: "acme" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    const [dataSql, dataParams] = pg.query.mock.calls[1];
    expect(countSql).toContain("first_name ILIKE $1");
    expect(countSql).toContain("last_name ILIKE $1");
    expect(countSql).toContain("email ILIKE $1");
    expect(countSql).toContain("phone ILIKE $1");
    expect(countSql).toContain("company_name ILIKE $1");
    expect(countParams).toEqual(["%acme%"]);
    expect(dataSql).toContain("LIMIT $2 OFFSET $3");
    expect(dataParams).toEqual(["%acme%", 20, 0]);
  });

  it("allows whitelisted lead sorts and falls back for invalid sorts", async () => {
    setFindAllResult(0);
    await findAll({ sortBy: "value:asc" });
    expect(pg.query.mock.calls[1][0]).toContain("ORDER BY value ASC");

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "status:desc; DROP TABLE leads" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds a lead by id and returns null when absent", async () => {
    const record = { id: "lead-1", email: "ada@example.com" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("lead-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM leads WHERE id = $1",
      ["lead-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("scopes findById to a workspace when one is supplied", async () => {
    // routes/forms.js resolves a recordId that arrived in an anonymous request
    // body. Without this filter a visitor holding another tenant's UUID would
    // get that lead read back and then overwritten by their submission.
    const record = { id: "lead-1", workspace_id: "ws_acme" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("lead-1", "ws_acme")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM leads WHERE id = $1 AND workspace_id = $2",
      ["lead-1", "ws_acme"],
    );
  });

  it("finds a lead by exact email, newest match first", async () => {
    const record = { id: "lead-2", email: "ada@example.com" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findByEmail("  ADA@Example.com ")).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    // Exact equality, not ILIKE: a substring match would let "a@b.co" overwrite
    // "xa@b.com".
    expect(sql).toContain("LOWER(COALESCE(email, '')) = LOWER($1)");
    expect(sql).not.toContain("ILIKE");
    expect(sql).toContain("ORDER BY created_at DESC LIMIT 1");
    expect(sql).not.toContain("workspace_id");
    expect(params).toEqual(["ADA@Example.com"]);
  });

  it("scopes the email lookup to a workspace when one is supplied", async () => {
    const record = { id: "lead-3", workspace_id: "ws_globex" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findByEmail("ada@example.com", "ws_globex")).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("AND workspace_id = $2");
    expect(params).toEqual(["ada@example.com", "ws_globex"]);
  });

  it("returns null from findByEmail without querying for a blank address", async () => {
    await expect(findByEmail("   ")).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();
  });

  it("creates a lead with parameterized fields", async () => {
    const data = {
      workspace_id: "workspace-1",
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      phone: "555-0100",
      company_name: "Analytical Engines",
      status: "Qualified",
      source: "Referral",
      value: 1250.5,
      owner_id: "user-1",
      custom_fields: { priority: "high" },
    };
    const record = { id: "lead-1", ...data };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(create(data)).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO leads");
    expect(sql).toContain("RETURNING *");
    expect(sql).toContain("$11");
    expect(params).toEqual([
      data.workspace_id,
      data.first_name,
      data.last_name,
      data.email,
      data.phone,
      data.company_name,
      data.status,
      data.source,
      data.value,
      data.owner_id,
      data.custom_fields,
    ]);
  });

  it("updates only whitelisted lead fields and appends the id parameter", async () => {
    const record = { id: "lead-1", status: "Customer" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("lead-1", {
      status: "Customer",
      custom_fields: { followed_up: true },
      workspace_id: "ignored",
      unknown: "ignored",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain(
      "status = $1, custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $2::jsonb",
    );
    expect(sql).toContain("WHERE id = $3");
    expect(sql).not.toContain("workspace_id = $");
    expect(sql).not.toContain("unknown = $");
    expect(params).toEqual(["Customer", '{"followed_up":true}', "lead-1"]);
  });

  it("returns null for an update with no allowed fields or no matching record", async () => {
    await expect(update("lead-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { status: "Customer" })).resolves.toBeNull();
  });

  it("reports whether a lead was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "lead-1" }] });
    await expect(deleteLead("lead-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM leads WHERE id = $1 RETURNING id",
      ["lead-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteLead("missing")).resolves.toBe(false);
  });
});
