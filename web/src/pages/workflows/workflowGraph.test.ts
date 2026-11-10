import { describe, expect, it } from "vitest";
import { graphFingerprint, graphPayload, readWorkflowGraph } from "./workflowGraph";

describe("persisted workflow graphs", () => {
  const stored = {
    nodes: [{ id: "trigger", type: "trigger", position: { x: 12, y: 34 }, data: { event: "lead.created" }, custom: "preserve" },
      { id: "action", type: "action", position: { x: 450, y: 80 }, data: { type: "task", configuration: { title: "Follow up" } } }],
    edges: [{ id: "link", source: "trigger", target: "action", sourceHandle: "yes", custom: true }],
  };
  it("round-trips positions, node configuration, handles and custom graph fields", () => {
    expect(graphPayload(readWorkflowGraph(stored))).toEqual(stored);
  });
  it("preserves explicitly empty graphs instead of synthesizing legacy nodes", () => {
    expect(readWorkflowGraph({ nodes: [], edges: [], event: "lead.created" })).toEqual({ nodes: [], edges: [] });
  });
  it("does not count selection or canvas measurements as unsaved changes", () => {
    const graph = readWorkflowGraph(stored);
    const changed = { nodes: graph.nodes.map((node) => ({ ...node, selected: true, dragging: false, measured: { width: 220, height: 80 } })),
      edges: graph.edges.map((edge) => ({ ...edge, selected: true })) };
    expect(graphFingerprint(changed)).toBe(graphFingerprint(graph));
    changed.nodes[0].position = { x: 99, y: 100 };
    expect(graphFingerprint(changed)).not.toBe(graphFingerprint(graph));
  });
  it("compares equivalent server JSON independently of property order", () => {
    const graph = readWorkflowGraph(stored);
    const reordered = { ...graph, nodes: graph.nodes.map((node) => {
      const { data, position, ...rest } = node;
      return { data, position, ...rest };
    }) };
    expect(graphFingerprint(reordered)).toBe(graphFingerprint(graph));
  });
  it("supplies deterministic layout and edge ids for older backend graph records", () => {
    const graph = readWorkflowGraph({ nodes: [{ id: "a", type: "trigger" }, { id: "b", type: "action" }],
      edges: [{ source: "a", target: "b" }] });
    expect(graph.nodes[0].position).toEqual({ x: 80, y: 120 });
    expect(graph.edges[0].id).toBe("edge-0-a-b");
  });
  it.each([null, {}, { nodes: "invalid", edges: [] },
    { nodes: [{ id: "a", type: "action" }, { id: "a", type: "action" }], edges: [] },
    { nodes: [{ id: "a", type: "action", position: { x: Infinity, y: 0 } }], edges: [] },
    { nodes: [{ id: "a", type: "action" }], edges: [{ source: "a", target: "missing" }] },
    { nodes: [{ id: "a", type: "action", data: [] }], edges: [] }])(
    "rejects malformed graphs rather than dropping their data (%s)", (value) => {
      expect(() => readWorkflowGraph(value)).toThrow();
    },
  );
});
