import { useState } from "react";

type ForecastItem = {
  label: string;
  pipeline: number;
  historical: number;
  probability?: number;
};

type Props = {
  chartData: ForecastItem[];
  money: (value: number) => string;
};

export function RevenueForecastChart({ chartData, money }: Props) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const width = 800;
  const height = 420;
  const margin = { top: 25, right: 25, bottom: 65, left: 90 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const maxValue = Math.max(
    1,
    ...chartData.flatMap((item) => [item.pipeline, item.historical]),
  );
  const maxY = maxValue * 1.15;
  const y = (value: number) =>
    margin.top + plotHeight - (value / maxY) * plotHeight;
  const step = plotWidth / Math.max(chartData.length, 1);
  const barWidth = Math.min(32, step * 0.45);

  const points = chartData
    .map(
      (item, index) =>
        `${margin.left + step * (index + 0.5)},${y(item.historical)}`,
    )
    .join(" ");

  return (
    <div style={{ width: "100%", height: 420, overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Revenue forecast chart"
        style={{ width: "100%", minWidth: 500, height: "100%" }}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const value = maxY * ratio;
          const yPos = y(value);
          return (
            <g key={ratio}>
              <line
                x1={margin.left}
                y1={yPos}
                x2={width - margin.right}
                y2={yPos}
                stroke="currentColor"
                opacity={0.15}
                strokeDasharray="4 4"
              />
              <text
                x={margin.left - 10}
                y={yPos + 4}
                textAnchor="end"
                fontSize="11"
                fill="currentColor"
              >
                {money(value)}
              </text>
            </g>
          );
        })}

        {chartData.map((item, index) => {
          const centerX = margin.left + step * (index + 0.5);
          const barHeight = (item.pipeline / maxY) * plotHeight;
          const isActive = activeIndex === index;
          const tooltipX = Math.min(width - 215, Math.max(5, centerX - 105));
          const tooltipY = Math.max(
            5,
            y(Math.max(item.pipeline, item.historical)) - 90,
          );

          return (
            <g
              key={`${item.label}-${index}`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
              onFocus={() => setActiveIndex(index)}
              onBlur={() => setActiveIndex(null)}
              tabIndex={0}
              role="img"
              aria-label={`${item.label}: pipeline ${money(item.pipeline)}, historique ${money(item.historical)}`}
              style={{ cursor: "pointer", outline: "none" }}
            >
              <rect
                x={centerX - barWidth / 2}
                y={y(item.pipeline)}
                width={barWidth}
                height={Math.max(0, barHeight)}
                fill="#8b5cf6"
                fillOpacity={isActive ? 1 : 0.65}
                rx={4}
              />

              <text
                x={centerX}
                y={height - margin.bottom + 22}
                textAnchor="middle"
                fontSize="11"
                fill="currentColor"
              >
                {item.label}
              </text>

              {isActive && (
                <g pointerEvents="none">
                  <rect
                    x={tooltipX}
                    y={tooltipY}
                    width={210}
                    height={80}
                    rx={6}
                    fill="#1f2937"
                  />
                  <text
                    x={tooltipX + 10}
                    y={tooltipY + 17}
                    fill="#ffffff"
                    fontSize="12"
                  >
                    {item.label}
                  </text>
                  <text
                    x={tooltipX + 10}
                    y={tooltipY + 35}
                    fill="#c4b5fd"
                    fontSize="11"
                  >
                    Pipeline: {money(item.pipeline)}
                  </text>
                  <text
                    x={tooltipX + 10}
                    y={tooltipY + 52}
                    fill="#6ee7b7"
                    fontSize="11"
                  >
                    Historical: {money(item.historical)}
                  </text>
                  <text
                    x={tooltipX + 10}
                    y={tooltipY + 69}
                    fill="#ffffff"
                    fontSize="10"
                  >
                    Probability: {Number(item.probability || 0).toFixed(0)}%
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {chartData.length > 0 && (
          <polyline
            points={points}
            fill="none"
            stroke="#10b981"
            strokeWidth={3}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {chartData.map((item, index) => (
          <circle
            key={`historical-${index}`}
            cx={margin.left + step * (index + 0.5)}
            cy={y(item.historical)}
            r={4}
            fill="#10b981"
          />
        ))}

        <g transform={`translate(${margin.left}, ${height - 25})`}>
          <rect width={12} height={12} rx={2} fill="#8b5cf6" />
          <text x={18} y={10} fontSize="11" fill="currentColor">
            Pipeline forecast
          </text>
          <line
            x1={170}
            y1={6}
            x2={190}
            y2={6}
            stroke="#10b981"
            strokeWidth={3}
          />
          <text x={198} y={10} fontSize="11" fill="currentColor">
            Historical won revenue
          </text>
        </g>
      </svg>
    </div>
  );
}
