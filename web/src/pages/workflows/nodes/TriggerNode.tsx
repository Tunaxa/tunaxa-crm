import { Handle, Position, type NodeProps } from "@xyflow/react";

type TriggerNodeData = {
  event: string;
};

export default function TriggerNode({
  data,
}: NodeProps & { data: TriggerNodeData }) {
  return (
    <div className="workflow-node trigger-node">
      <Handle type="source" position={Position.Right} />

      <div className="workflow-node-header">
        <span>Trigger</span>
      </div>

      <div className="workflow-node-body">
        <strong>{typeof data.event === "string" ? data.event || "No event configured" : "No event configured"}</strong>
      </div>
    </div>
  );
}
