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

  it("searches activity fields with parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "activity-1" }]);

    await findAll({ q: "follow" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    const [dataSql, dataParams] = pg.query.mock.calls[1];
    expect(countSql).toContain("subject ILIKE $1");
    expect(countSql).toContain("body ILIKE $1");
    expect(countSql).toContain("type ILIKE $1");
    expect(countSql).toContain("direction ILIKE $1");
    expect(countParams).toEqual(["%follow%"]);
    expect(dataSql).toContain("LIMIT $2 OFFSET $3");
    expect(dataParams).toEqual(["%follow%", 20, 0]);
  });

  it("allows every whitelisted activity sort and rejects malformed sorts", async () => {
    const sortColumns = ["created_at", "updated_at", "type", "subject", "direction"];
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
      user_id: "user-1",
      contact_id: "contact-1",
      deal_id: "deal-1",
      type: "email",
      subject: "Follow up",
      body: "Sent an email",
      direction: "outbound",
      metadata: { campaign: "spring" },
    };
    const record = { id: "activity-1", ...data };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(create(data)).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO activities");
    expect(sql).toContain("RETURNING *");
    expect(params).toEqual([
      data.workspace_id,
      data.user_id,
      data.contact_id,
      data.deal_id,
      data.type,
      data.subject,
      data.body,
      data.direction,
      data.metadata,
    ]);
  });

  it("updates only whitelisted activity fields and appends the id", async () => {
    const record = { id: "activity-1", direction: "inbound" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("activity-1", {
      direction: "inbound",
      body: "Received an email",
      workspace_id: "ignored",
      unknown: "ignored",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("body = $1, direction = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(sql).not.toContain("workspace_id = $");
    expect(sql).not.toContain("unknown = $");
    expect(params).toEqual(["Received an email", "inbound", "activity-1"]);
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
