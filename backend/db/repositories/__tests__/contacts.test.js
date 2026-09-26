import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as contacts from "../contacts.js";

const { create, findAll, findById, update } = contacts;
const deleteContact = contacts.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("contacts repository", () => {
  it("lists contacts with default pagination and total pages", async () => {
    const data = [{ id: "contact-1", first_name: "Ada" }];
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

  it("searches every contact search column with a parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "contact-1" }]);

    await findAll({ q: "acme" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    const [dataSql, dataParams] = pg.query.mock.calls[1];
    expect(countSql).toContain("first_name ILIKE $1");
    expect(countSql).toContain("last_name ILIKE $1");
    expect(countSql).toContain("email ILIKE $1");
    expect(countSql).toContain("phone ILIKE $1");
    expect(countSql).toContain("title ILIKE $1");
    expect(countParams).toEqual(["%acme%"]);
    expect(dataSql).toContain("LIMIT $2 OFFSET $3");
    expect(dataParams).toEqual(["%acme%", 20, 0]);
  });

  it("allows whitelisted ascending sorts and falls back for invalid sorts", async () => {
    setFindAllResult(0);
    await findAll({ sortBy: "email:asc" });
    expect(pg.query.mock.calls[1][0]).toContain("ORDER BY email ASC");

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "email; DROP TABLE contacts; --" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds a contact by id and returns null when absent", async () => {
    const record = { id: "contact-1", email: "ada@example.com" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("contact-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM contacts WHERE id = $1",
      ["contact-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("creates a contact with parameterized fields", async () => {
    const data = {
      workspace_id: "workspace-1",
      company_id: "company-1",
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      phone: "555-0100",
      title: "Engineer",
      owner_id: "user-1",
      custom_fields: { tier: "gold" },
    };
    const record = { id: "contact-1", ...data };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(create(data)).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO contacts");
    expect(sql).toContain("RETURNING *");
    expect(sql).toContain("$9");
    expect(params).toEqual([
      data.workspace_id,
      data.company_id,
      data.first_name,
      data.last_name,
      data.email,
      data.phone,
      data.title,
      data.owner_id,
      data.custom_fields,
    ]);
  });

  it("updates only whitelisted contact fields and appends the id parameter", async () => {
    const record = { id: "contact-1", first_name: "Grace" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("contact-1", {
      first_name: "Grace",
      custom_fields: { verified: true },
      workspace_id: "ignored",
      unknown: "ignored",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("first_name = $1, custom_fields = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(sql).not.toContain("workspace_id = $");
    expect(sql).not.toContain("unknown = $");
    expect(params).toEqual(["Grace", { verified: true }, "contact-1"]);
  });

  it("returns null for an update with no allowed fields or no matching record", async () => {
    await expect(update("contact-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { first_name: "Grace" })).resolves.toBeNull();
  });

  it("reports whether a contact was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "contact-1" }] });
    await expect(deleteContact("contact-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM contacts WHERE id = $1 RETURNING id",
      ["contact-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteContact("missing")).resolves.toBe(false);
  });
});
