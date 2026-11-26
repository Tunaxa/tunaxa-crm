import { useCallback, useEffect, useState, type DragEvent } from "react";
import type { WorkflowGraph } from "./workflowGraph";
import { useApp } from "../../context/AppContext";
import { canManageRecords } from "../../components/records/rbac";
import { ActionConfigPanel } from "./ActionConfigPanel";
import { templateConfiguration, type EmailTemplate } from "./emailTemplates";
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
import "./emailTemplatePreview.css";

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
  {
    type: "emailAction",
    label: "Add Send Email",
    section: "Actions",
  },
];

export function canConfigureTemplates(
  role: unknown,
  readOnly: boolean,
): boolean {
  return !readOnly && canManageRecords(role);
}

export default function WorkflowCanvas({
  workflow,
  readOnly = false,
  initialGraph,
  onGraphChange,
}: WorkflowCanvasProps) {
  const { user } = useApp();
  const canConfigure = canConfigureTemplates(user?.role, readOnly);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    if (!canConfigure) return;
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

      if (!reactFlowInstance || !canConfigure) {
        return;
      }

      const type = event.dataTransfer.getData(
        "application/reactflow",
      );

      if (!["trigger", "condition", "action", "emailAction"].includes(type)) {
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
      } else if (type === "emailAction") {
        data = {
          type: "send_email",
          configuration: {},
        };
      } else {
        data = {
          type: "Action",
          configuration: {},
        };
      }

      const newNode: Node = {
        id,
        type: type === "emailAction" ? "action" : type,
        position,
        data,
      };

      setNodes((currentNodes) => [
        ...currentNodes,
        newNode,
      ]);
    },
    [reactFlowInstance, canConfigure],
  );

  function addPaletteNode(type: string) {
    if (!canConfigure) return;
    const emailAction = type === "emailAction";
    const data = type === "trigger" ? { event: "" }
      : type === "condition" ? { field: "", value: "" }
      : emailAction ? { type: "send_email", configuration: {} }
      : { type: "Action", configuration: {} };
    setNodes((current) => [...current, {
      id: `${emailAction ? "action" : type}-${crypto.randomUUID()}`,
      type: emailAction ? "action" : type,
      position: { x: 80 + (current.length % 3) * 260, y: 80 + Math.floor(current.length / 3) * 160 }, data,
    }]);
  }

  const selected = nodes.find((node) => node.id === selectedId);
  const selectedConfiguration =
    selected && selected.data.configuration && typeof selected.data.configuration === "object" && !Array.isArray(selected.data.configuration)
      ? (selected.data.configuration as Record<string, unknown>)
      : {};

  function applyTemplate(template: EmailTemplate | null) {
    if (!canConfigure || !selectedId) return;
    setNodes((current) => current.map((node) => node.id === selectedId
      ? {
          ...node,
          data: {
            ...node.data,
            configuration: templateConfiguration(selectedConfiguration, template),
          },
        }
      : node));
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
              <button type="button" disabled={!canConfigure} onClick={() => addPaletteNode(item.type)}
                key={item.type}
                className="workflow-palette-item trigger-palette-item"
                draggable={canConfigure}
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
              <button type="button" disabled={!canConfigure} onClick={() => addPaletteNode(item.type)}
                key={item.type}
                className="workflow-palette-item condition-palette-item"
                draggable={canConfigure}
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
              <button type="button" disabled={!canConfigure} onClick={() => addPaletteNode(item.type)}
                key={item.type}
                className="workflow-palette-item action-palette-item"
                draggable={canConfigure}
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
          onNodeClick={(_, node) => {
            if (canConfigure && node.type === "action") setSelectedId(node.id);
          }}
          onPaneClick={() => setSelectedId(null)}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
          onInit={setReactFlowInstance}
          fitView
        >
          <Background />
          <Controls showInteractive={!readOnly} />
          <MiniMap className="workflow-minimap" pannable zoomable style={{ background: "var(--surface)" }} nodeColor="var(--muted)" />
        </ReactFlow>
      </div>

      {selected && selected.type === "action" && canConfigure && (
        <ActionConfigPanel
          actionType={String(selected.data.type || "Action")}
          templateId={typeof selectedConfiguration.templateId === "string" ? selectedConfiguration.templateId : ""}
          onSelect={applyTemplate}
          onClose={() => setSelectedId(null)}
          readOnly={!canConfigure}
        />
      )}
    </div>
  );
}
