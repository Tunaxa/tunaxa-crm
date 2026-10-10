import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../pg.js", () => ({ query: pg.query }));

import * as workflowRuns from "../workflow-runs.js";

const { create, update, findById, findByWorkflowId } = workflowRuns;

beforeEach(() => {
  pg.query.mockReset();
});

describe("workflow_runs repository", () => {
  it("creates a workflow run with parameterized JSONB fields", async () => {
    const data = {
      workflow_id: "wf-1",
      trigger_event: "lead.created",
      status: "running",
      workspace_id: "ws-1",
      steps: [{ nodeId: "n1", status: "success" }],
    };
    const row = { id: "run-1", ...data };
    pg.query.mockResolvedValueOnce({ rows: [row] });

    const result = await create(data);
    expect(result).toBe(row);

    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO workflow_runs");
    expect(sql).toContain("RETURNING *");
    expect(params[0]).toBe("ws-1");
    expect(params[1]).toBe("wf-1");
    expect(params[2]).toBe("lead.created");
    expect(params[3]).toBe("running");
    expect(params[6]).toBe(JSON.stringify(data.steps));
  });

  it("updates workflow run status, completed_at, and steps", async () => {
    const row = { id: "run-1", status: "success" };
    pg.query.mockResolvedValueOnce({ rows: [row] });

    const result = await update("run-1", {
      status: "success",
      completed_at: "2026-09-26T16:00:00.000Z",
      steps: [{ nodeId: "n1", status: "success" }],
    });

    expect(result).toBe(row);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain("UPDATE workflow_runs");
    expect(sql).toContain("status = $1");
    expect(sql).toContain("completed_at = $2");
    expect(sql).toContain("steps = $3");
    expect(params[0]).toBe("success");
    expect(params[2]).toBe(JSON.stringify([{ nodeId: "n1", status: "success" }]));
    expect(params[3]).toBe("run-1");
  });

  it("finds a run by id and returns null when missing", async () => {
    const row = { id: "run-1" };
    pg.query.mockResolvedValueOnce({ rows: [row] });
    await expect(findById("run-1")).resolves.toBe(row);

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(findById("missing")).resolves.toBeNull();
  });

  it("finds runs by workflow_id with pagination and optional workspace_id scoping", async () => {
    pg.query
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: "run-1", workflow_id: "wf-1" }] });

    const res = await findByWorkflowId("wf-1", { page: 1, limit: 10, workspaceId: "ws-acme" });
    expect(res.total).toBe(1);
    expect(res.data).toHaveLength(1);

    const [countSql, countParams] = pg.query.mock.calls[0];
    const [dataSql, dataParams] = pg.query.mock.calls[1];
    expect(countSql).toContain("workflow_id = $1 AND workspace_id = $2");
    expect(countParams).toEqual(["wf-1", "ws-acme"]);
    expect(dataSql).toContain("ORDER BY started_at DESC");
    expect(dataParams).toEqual(["wf-1", "ws-acme", 10, 0]);
  });
});
