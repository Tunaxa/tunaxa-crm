import type { CSSProperties, HTMLAttributes } from "react";

type ChamferProps = HTMLAttributes<HTMLDivElement> & {
  size?: string;
};

export function Chamfer({
  size = "var(--space-2)",
  className = "",
  style,
  ...props
}: ChamferProps) {
  const chamferStyle = {
    "--chamfer-size": size,
    ...style,
  } as CSSProperties;

  return (
    <div
      className={`chamfer ${className}`.trim()}
      style={chamferStyle}
      {...props}
    />
  );
}