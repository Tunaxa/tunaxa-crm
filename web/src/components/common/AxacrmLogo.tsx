import React from "react";

interface AxacrmLogoProps {
  size?: "sm" | "md" | "lg";
  className?: string;
  showTunaxaPrefix?: boolean;
}

export const AxacrmLogo: React.FC<AxacrmLogoProps> = ({
  size = "md",
  className = "",
  showTunaxaPrefix = true,
}) => {
  const sizeMap = {
    sm: {
      box: "w-7 h-7 p-1",
      text: "text-base sm:text-lg",
      badge: "text-[10px] px-1.5 py-0.5",
    },
    md: {
      box: "w-8 h-8 p-1.5",
      text: "text-lg sm:text-xl",
      badge: "text-xs px-2 py-0.5",
    },
    lg: {
      box: "w-10 h-10 p-2",
      text: "text-2xl sm:text-3xl",
      badge: "text-sm px-2.5 py-1",
    },
  };

  return (
    <div
      className={`inline-flex items-center gap-2.5 font-sans select-none ${className}`}
    >
      {/* Chamfered brand mark */}
      {/* Official Tunaxa Brand Monogram Mark */}
      <div
        className={`${sizeMap[size].box} bg-black text-white dark:bg-white dark:text-black flex items-center justify-center shrink-0 transition-transform group-hover:scale-105 border border-black dark:border-white`}
        style={{
          clipPath:
            "polygon(3px 0%, 100% 0%, 100% calc(100% - 3px), calc(100% - 3px) 100%, 0% 100%, 0% 3px)",
          // 'polygon(4px 0%, 100% 0%, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0% 100%, 0% 4px)',
        }}
      >
        <svg
          viewBox="0 0 512 512"
          className="w-full h-full"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M150 174V274C150 305 167 321 190 321C213 321 221 303 221 275V211C221 195 226 184 237 184C244 184 248 191 254 202L308 300C318 318 328 326 339 326C350 326 356 313 356 287V174"
            fill="none"
            stroke="currentColor"
            strokeWidth="32"
            strokeLinecap="butt"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <div className="flex flex-col text-left">
        {showTunaxaPrefix && (
          <span className="text-[9px] font-mono font-semibold tracking-widest text-[#737373] dark:text-[#8b949e] uppercase -mb-1">
            TUNAXA 
          </span>
        )}
        <div className="flex items-center gap-1.5">
          <span
            className={`${sizeMap[size].text} font-black tracking-tight uppercase text-[#171717] dark:text-white`}
          >
            AXA<span className="text-[#3b82f6]">CRM</span>
          </span>
        </div>
      </div>
    </div>
  );
};
