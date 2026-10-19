import { useCallback, useState, type DragEvent } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import TriggerNode from "./nodes/TriggerNode";
import ConditionNode from "./nodes/ConditionNode";
import ActionNode from "./nodes/ActionNode";
import { ActionConfigPanel } from "./ActionConfigPanel";
import { templateConfiguration } from "./emailTemplates";
import "./emailTemplatePreview.css";

type WorkflowCanvasProps = {
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
  { type: "emailAction", label: "Send Email", section: "Actions" },
];

export default function WorkflowCanvas({
  workflow,
}: WorkflowCanvasProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reactFlowInstance, setReactFlowInstance] =
    useState<ReactFlowInstance | null>(null);

  const [nodes, setNodes] = useState<Node[]>(() => {
    const initialNodes: Node[] = [];

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

  const [edges] = useState<Edge[]>(() => {
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

  const onDragStart = (
    event: DragEvent<HTMLDivElement>,
    nodeType: string,
  ) => {
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

      if (!reactFlowInstance) {
        return;
      }

      const paletteType = event.dataTransfer.getData(
        "application/reactflow",
      );
      if (!["trigger", "condition", "action", "emailAction"].includes(paletteType)) {
        return;
      }
      const type = paletteType === "emailAction" ? "action" : paletteType;

      const position =
        reactFlowInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });

      const id = `${type}-${Date.now()}`;

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
          type: paletteType === "emailAction" ? "send_email" : "Action",
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
      if (type === "action") setSelectedId(id);
    },
    [reactFlowInstance],
  );

  const selected = nodes.find(node => node.id === selectedId && node.type === "action");
  const selectedConfig = selected?.data.configuration && typeof selected.data.configuration === "object" && !Array.isArray(selected.data.configuration)
    ? selected.data.configuration as Record<string, unknown> : {};

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
              <div
                key={item.type}
                className="workflow-palette-item trigger-palette-item"
                draggable
                onDragStart={(event) =>
                  onDragStart(event, item.type)
                }
              >
                {item.label}
              </div>
            ))}
        </section>

        <section className="workflow-palette-section">
          <h4>Conditions</h4>

          {paletteItems
            .filter(
              (item) => item.section === "Conditions",
            )
            .map((item) => (
              <div
                key={item.type}
                className="workflow-palette-item condition-palette-item"
                draggable
                onDragStart={(event) =>
                  onDragStart(event, item.type)
                }
              >
                {item.label}
              </div>
            ))}
        </section>

        <section className="workflow-palette-section">
          <h4>Actions</h4>
          <button type="button" className="btn secondary compact" onClick={() => {
            const id = `action-${crypto.randomUUID()}`;
            setNodes(current => [...current, { id, type: "action", position: { x: 650, y: 150 }, data: { type: "send_email", configuration: {} } }]);
            setSelectedId(id);
          }}>Add Send Email</button>

          {paletteItems
            .filter(
              (item) => item.section === "Actions",
            )
            .map((item) => (
              <div
                key={item.type}
                className="workflow-palette-item action-palette-item"
                draggable
                onDragStart={(event) =>
                  onDragStart(event, item.type)
                }
              >
                {item.label}
              </div>
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
          onInit={setReactFlowInstance}
          onNodeClick={(_, node) => setSelectedId(node.type === "action" ? node.id : null)}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      {selected && <ActionConfigPanel key={selected.id} actionType={String(selected.data.type || "Action")}
        templateId={typeof selectedConfig.templateId === "string" ? selectedConfig.templateId : ""}
        onClose={() => setSelectedId(null)} onSelect={template => setNodes(current => current.map(node => node.id === selected.id
          ? { ...node, data: { ...node.data, configuration: templateConfiguration(selectedConfig, template) } } : node))} />}
    </div>
  );
}
