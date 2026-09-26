import React from "react";

export interface CornerBracketsProps {
  className?: string;
  size?: "sm" | "md" | "lg" | number;
  stroke?: string;
}

export const CornerBrackets: React.FC<CornerBracketsProps> = ({
  className = "text-black dark:text-white",
  size = "md",
  stroke,
}) => {
  const isCustomSize = typeof size === "number";
  const customDim = isCustomSize ? `${size}px` : undefined;
  const dim =
    size === "sm"
      ? "w-2 h-2"
      : size === "lg"
        ? "w-3.5 h-3.5"
        : isCustomSize
          ? ""
          : "w-2.5 h-2.5";

  const styleProps: React.CSSProperties = {
    ...(customDim ? { width: customDim, height: customDim } : {}),
    ...(stroke ? { borderColor: stroke } : {}),
    ...(stroke ? { color: stroke } : {}),
  };

  const defaultBorderClass = stroke
    ? ""
    : "border-[#d1d1d1] dark:border-[#263140]";

  return (
    <>
      {/* Top Left */}
      <div
        style={styleProps}
        className={`absolute top-0 left-0 ${dim} pointer-events-none z-10 ${className}`}
      >
        <div className="absolute top-0 left-0 w-full h-[1.5px] bg-current" />
        <div className="absolute top-0 left-0 w-[1.5px] h-full bg-current" />
      </div>
      {/* Top Right */}
      <div
        style={styleProps}
        className={`absolute top-0 right-0 ${dim} pointer-events-none z-10 ${className}`}
      >
        <div className="absolute top-0 right-0 w-full h-[1.5px] bg-current" />
        <div className="absolute top-0 right-0 w-[1.5px] h-full bg-current" />
      </div>
      {/* Bottom Right */}
      <div
        style={styleProps}
        className={`absolute bottom-0 right-0 ${dim} pointer-events-none z-10 ${className}`}
      >
        <div className="absolute bottom-0 right-0 w-full h-[1.5px] bg-current" />
        <div className="absolute bottom-0 right-0 w-[1.5px] h-full bg-current" />
      </div>
      {/* Bottom Left */}
      <div
        style={styleProps}
        className={`absolute bottom-0 left-0 ${dim} pointer-events-none z-10 ${className}`}
      >
        <div className="absolute bottom-0 left-0 w-full h-[1.5px] bg-current" />
        <div className="absolute bottom-0 left-0 w-[1.5px] h-full bg-current" />
      </div>
    </>
  );
};
