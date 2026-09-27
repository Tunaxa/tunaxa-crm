import { Handle, Position, type NodeProps } from "@xyflow/react";

type ConditionNodeData = {
  field: string;
  value: string;
};

export default function ConditionNode({
  data,
}: NodeProps & { data: ConditionNodeData }) {
  const field = typeof data.field === "string" ? data.field : "";
  const value = typeof data.value === "string" || typeof data.value === "number" ? String(data.value) : "";
  return (
    <div className="workflow-node condition-node">
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      <div className="workflow-node-header">
        <span>Condition</span>
      </div>

      <div className="workflow-node-body">
        <strong>
          {field || "Field"} = {value || "Value"}
        </strong>

        <div className="condition-summary">
          IF {field || "field"} = {value || "value"}
        </div>
      </div>
    </div>
  );
}
