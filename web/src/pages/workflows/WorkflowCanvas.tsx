
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import TriggerNode from "./nodes/TriggerNode";
import ConditionNode from "./nodes/ConditionNode";
import ActionNode from "./nodes/ActionNode";

type WorkflowCanvasProps = {
  workflow: {
    event?: string;
    filter?: {
      field?: string;
      value?: string;
    } | null;
    actions?: Array<Record<string, any>>;
  };
};

const nodeTypes = {
  trigger: TriggerNode,
  condition: ConditionNode,
  action: ActionNode,
};

export default function WorkflowCanvas({
  workflow,
}: WorkflowCanvasProps) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  nodes.push({
    id: "trigger",
    type: "trigger",
    position: { x: 50, y: 150 },
    data: {
      event: workflow.event || "",
    },
  });

  let previousId = "trigger";

  if (workflow.filter?.field) {
    nodes.push({
      id: "condition",
      type: "condition",
      position: { x: 350, y: 150 },
      data: {
        field: workflow.filter.field || "",
        value: workflow.filter.value || "",
      },
    });

    edges.push({
      id: "trigger-condition",
      source: "trigger",
      target: "condition",
    });

    previousId = "condition";
  }

  (workflow.actions || []).forEach((action, index) => {
    const id = `action-${index}`;

    const configuration = { ...action };
    delete configuration.type;

    nodes.push({
      id,
      type: "action",
      position: { x: 650 + index * 280, y: 150 },
      data: {
        type: action.type || "Action",
        configuration,
      },
    });

    edges.push({
      id: `${previousId}-${id}`,
      source: previousId,
      target: id,
    });

    previousId = id;
  });

  return (
    <div className="workflow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}