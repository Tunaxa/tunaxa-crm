import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkflowPicker, workflowLastRun, workflowEnabled, workflowName } from "./WorkflowPicker";
import WorkflowCanvas from "./WorkflowCanvas";

const handlers = { onClose: () => {}, onSelect: () => {}, onRetry: () => {} };
describe("workflow picker", () => {
  it("shows names, statuses and timestamps without confusing missing history with never run", () => {
    const html = renderToStaticMarkup(<WorkflowPicker {...handlers} loading={false} error={null}
      workflows={[{ id: "w1", name: "Follow up", enabled: true }, { id: "w2", enabled: false, lastRunAt: "invalid" }]} />);
    expect(html).toContain("Follow up");
    expect(html).toContain("Untitled workflow");
    expect(html).toContain("Enabled");
    expect(html).toContain("Disabled");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("Never run");
    expect(html).toContain("Last Run");
  });
  it("keeps loading and request errors separate from an empty list", () => {
    const loading = renderToStaticMarkup(<WorkflowPicker {...handlers} workflows={[]} loading error={null} />);
    expect(loading).toContain("Loading workflows");
    expect(loading).not.toContain("No workflows");
    const failed = renderToStaticMarkup(<WorkflowPicker {...handlers} workflows={[]} loading={false} error="Request failed" />);
    expect(failed).toContain("Could not load workflows");
    expect(failed).toContain("Retry");
    expect(failed).not.toContain("No workflows");
  });
  it("offers a truthful empty state", () => {
    const html = renderToStaticMarkup(<WorkflowPicker {...handlers} workflows={[]} loading={false} error={null} />);
    expect(html).toContain("Create a workflow before opening its canvas");
  });
  it("handles legacy booleans and malformed list metadata", () => {
    expect(workflowEnabled("false")).toBe(false);
    expect(workflowEnabled("true")).toBe(true);
    expect(workflowLastRun(undefined)).toBe("Unavailable");
    expect(workflowLastRun("invalid")).toBe("Unavailable");
    expect(workflowLastRun("2026-09-27T10:00:00Z")).not.toBe("Unavailable");
    expect(workflowName({ id: "w1", name: {} })).toBe("Untitled workflow");
  });
});

describe("workflow canvas foundation", () => {
  it("renders a blank workflow with controls and a minimap", () => {
    const html = renderToStaticMarkup(<WorkflowCanvas workflow={{}} />);
    expect(html).toContain("react-flow__minimap");
    expect(html).toContain("react-flow__controls");
    expect(html).not.toContain('data-id="trigger"');
  });
  it("disables palette actions and dragging for read-only users", () => {
    const html = renderToStaticMarkup(<WorkflowCanvas readOnly workflow={{}} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*class="workflow-palette-item/);
    expect(html).not.toContain('draggable="true"');
    expect(html).not.toContain("react-flow__controls-interactive");
  });
});
