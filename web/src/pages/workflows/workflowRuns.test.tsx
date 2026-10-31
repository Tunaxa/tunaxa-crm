import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkflowRunDetails } from "./WorkflowRunHistory";
import { readRunPage, runTimestamp } from "./workflowRuns";

const response = { page: 1, total: 1, totalPages: 1, data: [{
  id: "run-1", workflow_id: "flow-1", trigger_event: "lead.created", status: "failed",
  started_at: "2026-09-27T10:00:00Z", completed_at: "2026-09-27T10:01:00Z",
  error_message: "Email delivery failed", steps: [
    { nodeId: "trigger", nodeName: "Lead created", nodeType: "trigger", status: "success" },
    { nodeId: "send", nodeName: "Send email", nodeType: "action", status: "failed", error: "Delivery error" },
    { nodeId: "follow", nodeType: "action", status: "skipped" },
  ],
}] };

describe("workflow run history contract", () => {
  it("reads the backend's snake-case run fields and ordered node outcomes", () => {
    const run = readRunPage(response, "flow-1").data[0];
    expect(run).toMatchObject({ id: "run-1", triggerEvent: "lead.created", status: "failed", error: "Email delivery failed" });
    expect(run.steps?.map((step) => step.status)).toEqual(["success", "failed", "skipped"]);
  });
  it("renders failed and skipped nodes distinctly instead of calling every step successful", () => {
    const run = readRunPage(response, "flow-1").data[0];
    const html = renderToStaticMarkup(<WorkflowRunDetails run={run} onClose={() => {}} />);
    expect(html).toContain("Lead created");
    expect(html).toContain("Send email");
    expect(html).toContain("Success");
    expect(html).toContain("Failed");
    expect(html).toContain("Skipped");
    expect(html).toContain("Delivery error");
  });
  it("distinguishes missing step details from a real empty steps array", () => {
    const malformed = { ...response, data: [{ ...response.data[0], steps: {} }] };
    const html = renderToStaticMarkup(<WorkflowRunDetails run={readRunPage(malformed, "flow-1").data[0]} onClose={() => {}} />);
    expect(html).toContain("Step details are unavailable");
    expect(html).not.toContain("No steps were recorded");
    expect(readRunPage({ page: 1, total: 0, totalPages: 0, data: [] }, "flow-1").data).toEqual([]);
  });
  it("shows unknown statuses and invalid timestamps without inventing a successful run", () => {
    expect(readRunPage({ ...response, data: [{ ...response.data[0], status: "new-status" }] }, "flow-1").data[0].status).toBe("unknown");
    expect(runTimestamp("bad date")).toBe("Unavailable");
    expect(runTimestamp("")).toBe("Unavailable");
  });
  it("rejects records belonging to a different workflow", () => {
    expect(() => readRunPage(response, "other-flow")).toThrow("Invalid workflow run reference");
  });
  it.each([null, {}, { ...response, page: -1 }, { ...response, total: "1" },
    { ...response, data: [{ ...response.data[0], id: null }] },
    { ...response, data: [response.data[0], response.data[0]] }])(
    "rejects malformed list/pagination responses (%s)", (value) => {
      expect(() => readRunPage(value, "flow-1")).toThrow();
    },
  );
});
