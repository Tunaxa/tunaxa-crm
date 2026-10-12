import { Handle, Position, type NodeProps } from "@xyflow/react";

type ConditionNodeData = {
  field: string;
  value: string;
};

export default function ConditionNode({
  data,
}: NodeProps & { data: ConditionNodeData }) {
  return (
    <div className="workflow-node condition-node">
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      <div className="workflow-node-header">
        <span>Condition</span>
      </div>

      <div className="workflow-node-body">
        <strong>
          {data.field || "Field"} = {data.value || "Value"}
        </strong>

        <div className="condition-summary">
          IF {data.field || "field"} = {data.value || "value"}
        </div>
      </div>
    </div>
  );
}