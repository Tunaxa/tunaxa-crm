import { useCallback, useEffect, useState, type DragEvent } from "react";
import type { WorkflowGraph } from "./workflowGraph";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import TriggerNode from "./nodes/TriggerNode";
import ConditionNode from "./nodes/ConditionNode";
import ActionNode from "./nodes/ActionNode";

type WorkflowCanvasProps = {
  initialGraph?: WorkflowGraph;
  onGraphChange?: (graph: WorkflowGraph) => void;
  readOnly?: boolean;
  workflow: {
    event?: string;
    filter?: {
      field?: string;
      value?: string;
    } | null;
    actions?: Array<Record<string, unknown>>;
  };
};

const nodeTypes = {
  trigger: TriggerNode,
  condition: ConditionNode,
  action: ActionNode,
};

const paletteItems = [
  {
    type: "trigger",
    label: "Trigger",
    section: "Triggers",
  },
  {
    type: "condition",
    label: "Condition",
    section: "Conditions",
  },
  {
    type: "action",
    label: "Action",
    section: "Actions",
  },
];

export default function WorkflowCanvas({
  workflow,
  readOnly = false,
  initialGraph,
  onGraphChange,
}: WorkflowCanvasProps) {
  const [reactFlowInstance, setReactFlowInstance] =
    useState<ReactFlowInstance | null>(null);

  const [nodes, setNodes] = useState<Node[]>(() => {
    if (initialGraph) return initialGraph.nodes;
    const initialNodes: Node[] = [];

    if (!workflow.event && !workflow.filter?.field && !workflow.actions?.length) return initialNodes;

    initialNodes.push({
      id: "trigger",
      type: "trigger",
      position: { x: 50, y: 150 },
      data: {
        event: workflow.event || "",
      },
    });

    if (workflow.filter?.field) {
      initialNodes.push({
        id: "condition",
        type: "condition",
        position: { x: 350, y: 150 },
        data: {
          field: workflow.filter.field,
          value: workflow.filter.value || "",
        },
      });
    }

    (workflow.actions || []).forEach((action, index) => {
      const id = `action-${index}`;

      const configuration = { ...action };
      delete configuration.type;

      initialNodes.push({
        id,
        type: "action",
        position: {
          x: 650 + index * 280,
          y: 150,
        },
        data: {
          type:
            typeof action.type === "string"
              ? action.type
              : "Action",
          configuration,
        },
      });
    });

    return initialNodes;
  });

  const [edges, setEdges] = useState<Edge[]>(() => {
    if (initialGraph) return initialGraph.edges;
    const initialEdges: Edge[] = [];

    let previousId = "trigger";

    if (workflow.filter?.field) {
      initialEdges.push({
        id: "trigger-condition",
        source: "trigger",
        target: "condition",
      });

      previousId = "condition";
    }

    (workflow.actions || []).forEach((_, index) => {
      const id = `action-${index}`;

      initialEdges.push({
        id: `${previousId}-${id}`,
        source: previousId,
        target: id,
      });

      previousId = id;
    });

    return initialEdges;
  });

  useEffect(() => { onGraphChange?.({ nodes, edges }); }, [nodes, edges, onGraphChange]);

  const onDragStart = (
    event: DragEvent<HTMLElement>,
    nodeType: string,
  ) => {
    if (readOnly) return;
    event.dataTransfer.setData(
      "application/reactflow",
      nodeType,
    );

    event.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();

      if (!reactFlowInstance || readOnly) {
        return;
      }

      const type = event.dataTransfer.getData(
        "application/reactflow",
      );

      if (!["trigger", "condition", "action"].includes(type)) {
        return;
      }

      const position =
        reactFlowInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });

      const id = `${type}-${crypto.randomUUID()}`;

      let data: Record<string, unknown>;

      if (type === "trigger") {
        data = {
          event: "New event",
        };
      } else if (type === "condition") {
        data = {
          field: "field",
          value: "value",
        };
      } else {
        data = {
          type: "Action",
          configuration: {},
        };
      }

      const newNode: Node = {
        id,
        type,
        position,
        data,
      };

      setNodes((currentNodes) => [
        ...currentNodes,
        newNode,
      ]);
    },
    [reactFlowInstance, readOnly],
  );

  function addPaletteNode(type: string) {
    if (readOnly) return;
    const data = type === "trigger" ? { event: "" }
      : type === "condition" ? { field: "", value: "" }
      : { type: "Action", configuration: {} };
    setNodes((current) => [...current, {
      id: `${type}-${crypto.randomUUID()}`, type,
      position: { x: 80 + (current.length % 3) * 260, y: 80 + Math.floor(current.length / 3) * 160 }, data,
    }]);
  }

  return (
    <div className="workflow-builder">
      <aside className="workflow-palette">
        <div className="workflow-palette-title">
          Node Palette
        </div>

        <section className="workflow-palette-section">
          <h4>Triggers</h4>

          {paletteItems
            .filter(
              (item) => item.section === "Triggers",
            )
            .map((item) => (
              <button type="button" disabled={readOnly} onClick={() => addPaletteNode(item.type)}
                key={item.type}
                className="workflow-palette-item trigger-palette-item"
                draggable={!readOnly}
                onDragStart={(event) =>
                  onDragStart(event, item.type)
                }
              >
                {item.label}
              </button>
            ))}
        </section>

        <section className="workflow-palette-section">
          <h4>Conditions</h4>

          {paletteItems
            .filter(
              (item) => item.section === "Conditions",
            )
            .map((item) => (
              <button type="button" disabled={readOnly} onClick={() => addPaletteNode(item.type)}
                key={item.type}
                className="workflow-palette-item condition-palette-item"
                draggable={!readOnly}
                onDragStart={(event) =>
                  onDragStart(event, item.type)
                }
              >
                {item.label}
              </button>
            ))}
        </section>

        <section className="workflow-palette-section">
          <h4>Actions</h4>

          {paletteItems
            .filter(
              (item) => item.section === "Actions",
            )
            .map((item) => (
              <button type="button" disabled={readOnly} onClick={() => addPaletteNode(item.type)}
                key={item.type}
                className="workflow-palette-item action-palette-item"
                draggable={!readOnly}
                onDragStart={(event) =>
                  onDragStart(event, item.type)
                }
              >
                {item.label}
              </button>
            ))}
        </section>
      </aside>

      <div
        className="workflow-canvas"
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={readOnly ? undefined : (changes) => setNodes((current) => applyNodeChanges(changes, current))}
          onEdgesChange={readOnly ? undefined : (changes) => setEdges((current) => applyEdgeChanges(changes, current))}
          onConnect={readOnly ? undefined : (connection) => setEdges((current) => addEdge(connection, current))}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
          onInit={setReactFlowInstance}
          fitView
        >
          <Background />
          <Controls showInteractive={!readOnly} />
          <MiniMap pannable zoomable style={{ background: "var(--surface)" }} nodeColor="var(--muted)" />
        </ReactFlow>
      </div>
    </div>
  );
}
