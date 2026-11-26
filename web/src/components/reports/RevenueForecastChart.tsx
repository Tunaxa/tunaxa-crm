import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type ForecastPoint = {
  label: string;
  historical: number;
  pipeline: number;
  probability: number;
};

type Props = {
  chartData: ForecastPoint[];
  money: (value: number) => string;
};

export function RevenueForecastChart({ chartData, money }: Props) {
  return (
    <div
      className="forecast-chart"
      role="img"
      aria-label="Revenue forecast chart"
      style={{ width: "100%", height: 420 }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={chartData}
          margin={{ top: 20, right: 20, left: 10, bottom: 10 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />

          <XAxis dataKey="label" stroke="var(--muted)" />

          <YAxis
            tickFormatter={(value) => money(Number(value))}
            stroke="var(--muted)"
          />

          <Tooltip
            formatter={(value, name, item) => {
              if (name === "pipeline") {
                return [
                  money(Number(value)),
                  `Weighted pipeline (${Number(item?.payload?.probability || 0).toFixed(0)}%)`,
                ];
              }

              return [
                money(Number(value)),
                name === "historical" ? "Historical won revenue" : String(name),
              ];
            }}
          />

          <Legend />

          <Bar
            dataKey="pipeline"
            name="Pipeline forecast"
            fill="var(--primary)"
            fillOpacity={0.65}
            radius={[4, 4, 0, 0]}
          />

          <Line
            type="monotone"
            dataKey="historical"
            name="Historical won revenue"
            stroke="var(--text)"
            strokeWidth={3}
            dot={{ r: 4, fill: "var(--text)" }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
