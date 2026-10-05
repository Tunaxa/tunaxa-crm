import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as activities from "../activities.js";

const { create, findAll, findById, update } = activities;
const deleteActivity = activities.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("activities repository", () => {
  it("lists activities with default pagination and total pages", async () => {
    const data = [{ id: "activity-1", subject: "Call" }];
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

  it("searches every activity search column with a parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "activity-1" }]);

    await findAll({ q: "follow" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    const [dataSql, dataParams] = pg.query.mock.calls[1];
    for (const column of [
      "title",
      "subject",
      "description",
      "contact",
      "company",
      "type",
      "direction",
    ]) {
      expect(countSql).toContain(`${column} ILIKE $1`);
    }
    expect(countParams).toEqual(["%follow%"]);
    expect(dataSql).toContain("LIMIT $2 OFFSET $3");
    expect(dataParams).toEqual(["%follow%", 20, 0]);
  });

  it("matches an exact type case-insensitively", async () => {
    setFindAllResult(1, [{ id: "activity-1" }]);

    await findAll({ type: "Email" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("LOWER(COALESCE(type, '')) = $1");
    expect(countParams).toEqual(["email"]);
  });

  it("treats type=system as everything outside the four direct types", async () => {
    setFindAllResult(1, [{ id: "activity-1" }]);

    await findAll({ type: "System" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("LOWER(COALESCE(type, '')) NOT IN");
    for (const direct of ["email", "call", "meeting", "note"]) {
      expect(countSql).toContain(`'${direct}'`);
    }
    // The direct types are literals, not a bound parameter, so `type=system`
    // must not consume one.
    expect(countParams).toEqual([]);
  });

  it("matches contact on the contact, company or title column", async () => {
    setFindAllResult(1, [{ id: "activity-1" }]);

    await findAll({ contact: "Acme Corp" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    const [dataSql, dataParams] = pg.query.mock.calls[1];
    expect(countSql).toContain("LOWER(COALESCE(contact, '')) = $1");
    expect(countSql).toContain("LOWER(COALESCE(company, '')) = $1");
    expect(countSql).toContain("COALESCE(title, '') ILIKE '%' || $1 || '%'");
    expect(countParams).toEqual(["acme corp"]);
    expect(dataSql).toContain("LIMIT $2 OFFSET $3");
    expect(dataParams).toEqual(["acme corp", 20, 0]);
  });

  it("matches a record by its linked id", async () => {
    setFindAllResult(1, [{ id: "activity-1" }]);

    await findAll({ recordId: "contact-1" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("record_id = $1");
    expect(countParams).toEqual(["contact-1"]);
  });

  it("ORs recordId and contact together instead of intersecting them", async () => {
    setFindAllResult(1, [{ id: "activity-1" }]);

    await findAll({ recordId: "contact-1", contact: "Acme" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    // One parenthesised OR group, so a row matching only the recordId or only
    // the contact still counts - the timeline relies on that to show a
    // record's events when only its name is known.
    expect(countSql).toContain(
      "WHERE (record_id = $1 OR LOWER(COALESCE(contact, '')) = $2 OR " +
        "LOWER(COALESCE(company, '')) = $2 OR " +
        "COALESCE(title, '') ILIKE '%' || $2 || '%')",
    );
    expect(countParams).toEqual(["contact-1", "acme"]);
  });

  it("intersects the timeline filters with the search term", async () => {
    setFindAllResult(1, [{ id: "activity-1" }]);

    await findAll({ q: "call", type: "Email", contact: "Acme" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    const [dataSql, dataParams] = pg.query.mock.calls[1];
    expect(countSql).toContain("title ILIKE $1");
    expect(countSql).toContain("LOWER(COALESCE(type, '')) = $2");
    expect(countSql).toContain("LOWER(COALESCE(contact, '')) = $3");
    expect(countParams).toEqual(["%call%", "email", "acme"]);
    expect(dataSql).toContain("LIMIT $4 OFFSET $5");
    expect(dataParams).toEqual(["%call%", "email", "acme", 20, 0]);
  });

  it("ignores blank filter values instead of filtering everything out", async () => {
    setFindAllResult(0);

    await findAll({ type: "", contact: "  ", recordId: "" });

    expect(pg.query.mock.calls[0][0]).not.toContain("WHERE");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("allows every whitelisted activity sort and rejects malformed sorts", async () => {
    const sortColumns = [
      "created_at",
      "updated_at",
      "type",
      "title",
      "subject",
      "direction",
    ];
    for (const column of sortColumns) {
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:asc` });
      const dataSql = pg.query.mock.calls[pg.query.mock.calls.length - 1][0];
      expect(dataSql).toContain(`ORDER BY ${column} ASC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "type:desc; DROP TABLE activities" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds an activity by id and returns null when absent", async () => {
    const record = { id: "activity-1", type: "email" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("activity-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM activities WHERE id = $1",
      ["activity-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("creates an activity with parameterized fields", async () => {
    const data = {
      workspace_id: "workspace-1",
      type: "Email",
      title: "Follow up",
      subject: "Re: pricing",
      description: "Sent an email",
      contact: "ada@example.com",
      company: "Acme",
      direction: "outbound",
      record_id: "contact-1",
      entity_type: "contact",
      entity_id: "contact-1",
      user_id: "user-1",
      contact_id: "contact-1",
      deal_id: "deal-1",
      metadata: { campaign: "spring" },
      custom_fields: { workflowId: "flow-1" },
    };
    const record = { id: "activity-1", ...data };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(create(data)).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO activities");
    expect(sql).toContain("RETURNING *");
    expect(sql).toContain("$16");
    expect(params).toEqual([
      data.workspace_id,
      data.type,
      data.title,
      data.subject,
      data.description,
      data.contact,
      data.company,
      data.direction,
      data.record_id,
      data.entity_type,
      data.entity_id,
      data.user_id,
      data.contact_id,
      data.deal_id,
      data.metadata,
      data.custom_fields,
    ]);
  });

  it("defaults metadata and custom_fields to empty objects on create", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ type: "Note" });

    const params = pg.query.mock.calls[0][1];
    expect(params.at(-2)).toEqual({});
    expect(params.at(-1)).toEqual({});
  });

  it("updates only whitelisted activity fields and appends the id", async () => {
    const record = { id: "activity-1", direction: "inbound" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("activity-1", {
      direction: "inbound",
      description: "Received an email",
      entity_id: "deal-2",
      body: "Received an email",
      workspace_id: "ignored",
      unknown: "ignored",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain(
      "description = $1, direction = $2, entity_id = $3",
    );
    expect(sql).toContain("WHERE id = $4");
    expect(sql).not.toContain("workspace_id = $");
    expect(sql).not.toContain("unknown = $");
    expect(params).toEqual([
      "Received an email",
      "inbound",
      "deal-2",
      "activity-1",
    ]);
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("activity-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { type: "email" })).resolves.toBeNull();
  });

  it("reports whether an activity was deleted", async () => {
    pg.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: "activity-1" }],
    });
    await expect(deleteActivity("activity-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM activities WHERE id = $1 RETURNING id",
      ["activity-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteActivity("missing")).resolves.toBe(false);
  });
});
