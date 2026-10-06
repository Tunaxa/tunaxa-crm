import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as tickets from "../tickets.js";

const { addComment, create, findAll, findById, update } = tickets;
const deleteTicket = tickets.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("tickets repository", () => {
  it("lists tickets with default pagination and total pages", async () => {
    const data = [{ id: "ticket-1" }];
    setFindAllResult(21, data);

    await expect(findAll()).resolves.toEqual({
      data,
      total: 21,
      page: 1,
      limit: 20,
      totalPages: 2,
    });
    expect(pg.query.mock.calls[0][0]).toContain("FROM tickets");
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
    const result = await findAll({ page: 2, limit: 500 });

    expect(result.limit).toBe(100);
    expect(pg.query.mock.calls[1][1]).toEqual([100, 100]);
  });

  it("searches subject, description, contact and contact_email", async () => {
    setFindAllResult(1, [{ id: "ticket-1" }]);

    await findAll({ q: "broken" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("subject ILIKE $1");
    expect(countSql).toContain("description ILIKE $1");
    expect(countSql).toContain("contact ILIKE $1");
    expect(countSql).toContain("contact_email ILIKE $1");
    expect(countParams).toEqual(["%broken%"]);
  });

  it("filters stage, priority and source exactly with independent parameters", async () => {
    setFindAllResult(1, [{ id: "ticket-1" }]);

    await findAll({ stage: "New", priority: "High", source: "Email" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("LOWER(COALESCE(stage, '')) = $1");
    expect(countSql).toContain("LOWER(COALESCE(priority, '')) = $2");
    expect(countSql).toContain("LOWER(COALESCE(source, '')) = $3");
    expect(countParams).toEqual(["new", "high", "email"]);
  });

  it("ignores blank filters", async () => {
    setFindAllResult(0);

    await findAll({ q: "  ", stage: "", priority: "", source: "" });

    expect(pg.query.mock.calls[0][0]).not.toContain("COALESCE(stage");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("allows every whitelisted sort and rejects malformed sorts", async () => {
    for (const column of [
      "created_at",
      "updated_at",
      "subject",
      "stage",
      "priority",
      "source",
      "resolved_at",
    ]) {
      pg.query.mockReset();
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:asc` });
      expect(pg.query.mock.calls[1][0]).toContain(`ORDER BY ${column} ASC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "subject:asc; DROP TABLE tickets" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds a ticket by id and returns null when absent", async () => {
    const record = { id: "ticket-1" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("ticket-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM tickets WHERE id = $1",
      ["ticket-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  // routes/tickets.js used to seed firstResponseAt and resolvedAt with empty
  // strings, and a legacy client can still send "". A timestamptz column
  // rejects that with 22007, so the repository normalizes it to null.
  it("normalizes empty-string timestamps to null on create", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({
      subject: "Broken",
      first_response_at: "",
      resolved_at: "",
    });

    const params = pg.query.mock.calls[0][1];
    expect(params[9]).toBeNull();
    expect(params[10]).toBeNull();
  });

  it("passes real timestamps through on create", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({
      subject: "Broken",
      first_response_at: "2026-03-01T10:00:00.000Z",
    });

    expect(pg.query.mock.calls[0][1][9]).toBe("2026-03-01T10:00:00.000Z");
  });

  it("serializes the comments array as jsonb", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ subject: "Broken", comments: [{ body: "hi" }] });

    expect(pg.query.mock.calls[0][1][8]).toBe('[{"body":"hi"}]');
  });

  it("defaults comments to an empty array", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ subject: "Broken" });

    expect(pg.query.mock.calls[0][1][8]).toBe("[]");
  });

  it("normalizes empty-string timestamps to null on update too", async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: "ticket-1" }] });

    await update("ticket-1", { first_response_at: "", resolved_at: "" });

    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("first_response_at = $1, resolved_at = $2");
    expect(params).toEqual([null, null, "ticket-1"]);
  });

  it("updates only whitelisted fields and appends the id", async () => {
    const record = { id: "ticket-1", stage: "In Progress" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("ticket-1", {
      stage: "In Progress",
      workspace_id: "ignored",
      id: "hacked",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("stage = $1");
    expect(sql).toContain("WHERE id = $2");
    expect(sql).not.toContain("workspace_id = $");
    expect(params).toEqual(["In Progress", "ticket-1"]);
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("ticket-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { stage: "New" })).resolves.toBeNull();
  });

  // The JSON handler read the row, unshifted onto the array and wrote the whole
  // thing back, so two concurrent comments lost one of them. The new element goes
  // on the LEFT of `||` because jsonb array concatenation appends on the right,
  // and the legacy ordering is newest-first.
  it("prepends a comment atomically and sets the first response time once", async () => {
    const record = { id: "ticket-1", comments: [{ body: "new" }] };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(addComment("ticket-1", { body: "new" })).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("comments = $2::jsonb || COALESCE(comments, '[]'::jsonb)");
    expect(sql).toContain("first_response_at = COALESCE(first_response_at, NOW())");
    expect(params).toEqual(["ticket-1", '[{"body":"new"}]']);
  });

  it("wraps a single comment in an array so the concatenation stays an array", async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: "ticket-1" }] });

    await addComment("ticket-1", { body: "note" });

    const serialized = pg.query.mock.calls[0][1][1];
    expect(Array.isArray(JSON.parse(serialized))).toBe(true);
    expect(JSON.parse(serialized)).toHaveLength(1);
  });

  it("returns null when commenting on a missing ticket", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(addComment("missing", { body: "x" })).resolves.toBeNull();
  });

  it("reports whether a ticket was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "ticket-1" }] });
    await expect(deleteTicket("ticket-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM tickets WHERE id = $1 RETURNING id",
      ["ticket-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteTicket("missing")).resolves.toBe(false);
  });
});
