import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as tasks from "../tasks.js";

const { create, findAll, findById, update } = tasks;
const deleteTask = tasks.delete;

function setFindAllResult(total, data = []) {
  pg.query
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows: data });
}

beforeEach(() => {
  pg.query.mockReset();
});

describe("tasks repository", () => {
  it("lists tasks with default pagination and total pages", async () => {
    const data = [{ id: "task-1", title: "Follow up" }];
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

  it("searches every task search column with a parameterized ILIKE", async () => {
    setFindAllResult(1, [{ id: "task-1" }]);

    await findAll({ q: "follow" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    const [dataSql, dataParams] = pg.query.mock.calls[1];
    expect(countSql).toContain("title ILIKE $1");
    expect(countSql).toContain("description ILIKE $1");
    expect(countSql).toContain("status ILIKE $1");
    expect(countSql).toContain("owner ILIKE $1");
    expect(countParams).toEqual(["%follow%"]);
    expect(dataSql).toContain("LIMIT $2 OFFSET $3");
    expect(dataParams).toEqual(["%follow%", 20, 0]);
  });

  it("filters on an exact status for the dashboard's open-work list", async () => {
    setFindAllResult(1, [{ id: "task-1" }]);

    await findAll({ status: "Open" });

    const [countSql, countParams] = pg.query.mock.calls[0];
    const [dataSql, dataParams] = pg.query.mock.calls[1];
    expect(countSql).toContain("LOWER(COALESCE(status, '')) = $1");
    // The SQL compares LOWER(status), so the bound parameter is folded to match.
    expect(countParams).toEqual(["open"]);
    expect(dataSql).toContain("LIMIT $2 OFFSET $3");
    expect(dataParams).toEqual(["open", 20, 0]);
  });

  it("binds completed as a real boolean so 'false' filters for open work", async () => {
    setFindAllResult(1, [{ id: "task-1" }]);

    await findAll({ completed: false });

    const [countSql, countParams] = pg.query.mock.calls[0];
    expect(countSql).toContain("completed = $1");
    expect(countParams).toEqual([false]);
  });

  it("leaves completed unset when the caller does not ask for it", async () => {
    setFindAllResult(0);

    await findAll({});

    expect(pg.query.mock.calls[0][0]).not.toContain("completed =");
    expect(pg.query.mock.calls[0][1]).toEqual([]);
  });

  it("combines search and status filters with independent parameters", async () => {
    setFindAllResult(1, [{ id: "task-1" }]);

    await findAll({ q: "call", status: "Open", completed: true });

    const [countSql, countParams] = pg.query.mock.calls[0];
    const [dataSql, dataParams] = pg.query.mock.calls[1];
    expect(countSql).toContain("title ILIKE $1");
    expect(countSql).toContain("LOWER(COALESCE(status, '')) = $2");
    expect(countSql).toContain("completed = $3");
    expect(countParams).toEqual(["%call%", "open", true]);
    expect(dataSql).toContain("LIMIT $4 OFFSET $5");
    expect(dataParams).toEqual(["%call%", "open", true, 20, 0]);
  });

  it("allows every whitelisted task sort and rejects malformed sorts", async () => {
    const sortColumns = [
      "created_at",
      "updated_at",
      "title",
      "status",
      "due_date",
      "priority",
    ];
    for (const column of sortColumns) {
      setFindAllResult(0);
      await findAll({ sortBy: `${column}:asc` });
      const dataSql = pg.query.mock.calls[pg.query.mock.calls.length - 1][0];
      expect(dataSql).toContain(`ORDER BY ${column} ASC`);
    }

    pg.query.mockReset();
    setFindAllResult(0);
    await findAll({ sortBy: "status:desc; DROP TABLE tasks" });
    const dataSql = pg.query.mock.calls[1][0];
    expect(dataSql).toContain("ORDER BY created_at DESC");
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("finds a task by id and returns null when absent", async () => {
    const record = { id: "task-1", title: "Follow up" };
    pg.query.mockResolvedValueOnce({ rows: [record] });
    await expect(findById("task-1")).resolves.toBe(record);
    expect(pg.query).toHaveBeenLastCalledWith(
      "SELECT * FROM tasks WHERE id = $1",
      ["task-1"],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("creates a task with parameterized fields", async () => {
    const data = {
      workspace_id: "workspace-1",
      title: "Follow up",
      description: "Call the customer",
      status: "Open",
      completed: false,
      priority: "High",
      owner: "Test User",
      assigned_to: "user-1",
      due_date: "2026-10-01T00:00:00.000Z",
      source: "workflow",
      contact_id: "contact-1",
      deal_id: "deal-1",
      custom_fields: { sequenceId: "seq-1" },
    };
    const record = { id: "task-1", ...data };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    await expect(create(data)).resolves.toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO tasks");
    expect(sql).toContain("RETURNING *");
    expect(sql).toContain("$13");
    expect(params).toEqual([
      data.workspace_id,
      data.title,
      data.description,
      data.status,
      data.completed,
      data.priority,
      data.owner,
      data.assigned_to,
      data.due_date,
      data.source,
      data.contact_id,
      data.deal_id,
      data.custom_fields,
    ]);
  });

  it("defaults completed to false and custom_fields to an empty object", async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });

    await create({ title: "Follow up" });

    const params = pg.query.mock.calls[0][1];
    expect(params[4]).toBe(false);
    expect(params.at(-1)).toEqual({});
  });

  it("updates only whitelisted task fields and appends the id", async () => {
    const record = { id: "task-1", status: "Completed" };
    pg.query.mockResolvedValueOnce({ rows: [record] });

    const result = await update("task-1", {
      status: "Completed",
      completed: true,
      assigned_to: "user-2",
      workspace_id: "ignored",
      unknown: "ignored",
    });

    expect(result).toBe(record);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain(
      "status = $1, completed = $2, assigned_to = $3",
    );
    expect(sql).toContain("WHERE id = $4");
    expect(sql).not.toContain("workspace_id = $");
    expect(sql).not.toContain("unknown = $");
    expect(params).toEqual(["Completed", true, "user-2", "task-1"]);
    expect(sql).toContain("description = $1, status = $2");
  });

  it("returns null for empty or non-matching updates", async () => {
    await expect(update("task-1", { unknown: "value" })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(update("missing", { status: "Completed" })).resolves.toBeNull();
  });

  it("reports whether a task was deleted", async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "task-1" }] });
    await expect(deleteTask("task-1")).resolves.toBe(true);
    expect(pg.query).toHaveBeenLastCalledWith(
      "DELETE FROM tasks WHERE id = $1 RETURNING id",
      ["task-1"],
    );

    pg.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteTask("missing")).resolves.toBe(false);
  });
});
