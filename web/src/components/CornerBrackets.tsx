import type { CSSProperties } from "react";

type CornerBracketsProps = {
  stroke: string;
  size?: "sm" | "md";
};

export function CornerBrackets({ stroke, size = "md" }: CornerBracketsProps) {
  return (
    <svg
      className={`corner-brackets corner-brackets-${size}`}
      aria-hidden="true"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ "--corner-bracket-stroke": stroke } as CSSProperties}
    >
      <path d="M0 16V0h16M84 0h16v16M100 84v16H84M16 100H0V84" />
    </svg>
  );
}