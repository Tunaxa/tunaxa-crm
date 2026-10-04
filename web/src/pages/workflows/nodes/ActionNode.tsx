import { Handle, Position, type NodeProps } from "@xyflow/react";

type ActionNodeData = {
  type: string;
  configuration?: Record<string, string>;
};

export default function ActionNode({
  data,
}: NodeProps & { data: ActionNodeData }) {
  const configuration = data.configuration || {};

  return (
    <div className="workflow-node action-node">
      <Handle type="target" position={Position.Left} />

      <div className="workflow-node-header">
        <span>Action</span>
      </div>

      <div className="workflow-node-body">
        <strong>{data.type || "Action"}</strong>

        {Object.entries(configuration).map(([key, value]) => (
          <div className="action-summary" key={key}>
            <span>{key}</span>
            <span>{String(value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}