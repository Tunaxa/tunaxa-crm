import type { Edge, Node } from "@xyflow/react";

export type WorkflowGraph = { nodes: Node[]; edges: Edge[] };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workflow graph record");
  return value as Record<string, unknown>;
};

export function readWorkflowGraph(value: unknown): WorkflowGraph {
  const graph = record(value);
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
    throw new Error("Workflow graph must contain nodes and edges arrays");
  const ids = new Set<string>();
  const nodes = graph.nodes.map((raw, index) => {
    const node = record(raw);
    if (typeof node.id !== "string" || !node.id || ids.has(node.id) || typeof node.type !== "string" || !node.type)
      throw new Error("Workflow graph contains invalid or duplicate nodes");
    ids.add(node.id);
    const position = node.position == null ? { x: 80 + index * 260, y: 120 } : record(node.position);
    if (typeof position.x !== "number" || !Number.isFinite(position.x) ||
      typeof position.y !== "number" || !Number.isFinite(position.y)) throw new Error("Invalid node position");
    return { ...node, position, data: node.data == null ? {} : record(node.data) } as Node;
  });
  const edgeIds = new Set<string>();
  const edges = graph.edges.map((raw, index) => {
    const edge = record(raw);
    if (typeof edge.source !== "string" || typeof edge.target !== "string" || !ids.has(edge.source) || !ids.has(edge.target))
      throw new Error("Workflow graph contains an edge with missing nodes");
    const id = typeof edge.id === "string" && edge.id ? edge.id : `edge-${index}-${edge.source}-${edge.target}`;
    if (edgeIds.has(id)) throw new Error("Workflow graph contains duplicate edges");
    edgeIds.add(id);
    return { ...edge, id } as Edge;
  });
  return { nodes, edges };
}

export function graphPayload(graph: WorkflowGraph): WorkflowGraph {
  return {
    nodes: graph.nodes.map((node) => {
      const { selected: _selected, dragging: _dragging, measured: _measured, ...stored } = node;
      return stored;
    }),
    edges: graph.edges.map((edge) => {
      const { selected: _selected, ...stored } = edge;
      return stored;
    }),
  };
}

export function graphFingerprint(graph: WorkflowGraph) {
  return JSON.stringify(graphPayload(graph), (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
}
