export type ReportEntity = "deals" | "contacts" | "leads";
export type ReportMetric = "count" | "sum" | "average";

export type ReportResultRow = {
  label: string;
  value: number;
};

export const reportGroupFields: Record<
  ReportEntity,
  { value: string; label: string }[]
> = {
  deals: [
    { value: "stage", label: "Stage" },
    { value: "owner", label: "Owner" },
    { value: "status", label: "Status" },
    { value: "company", label: "Company" },
  ],
  contacts: [
    { value: "company", label: "Company" },
    { value: "owner", label: "Owner" },
    { value: "status", label: "Status" },
    { value: "source", label: "Source" },
  ],
  leads: [
    { value: "status", label: "Status" },
    { value: "source", label: "Source" },
    { value: "owner", label: "Owner" },
    { value: "company", label: "Company" },
  ],
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function resultCollection(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload;
  const response = asRecord(payload);
  if (!response) return [];
  return (
    response.rows ??
    response.results ??
    response.data ??
    response.items ??
    []
  );
}

function numericValue(row: UnknownRecord) {
  const raw =
    row.value ??
    row.count ??
    row.total ??
    row.sum ??
    row.average ??
    row.avg ??
    0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

export function normalizeReportResults(
  payload: unknown,
  groupBy: string,
): ReportResultRow[] {
  const collection = resultCollection(payload);

  if (Array.isArray(collection)) {
    return collection.flatMap((item, index) => {
      const row = asRecord(item);
      if (!row) return [];
      const label = String(
        row.label ??
          row.name ??
          row.group ??
          row[groupBy] ??
          `Result ${index + 1}`,
      );
      return [{ label, value: numericValue(row) }];
    });
  }

  const mapped = asRecord(collection);
  if (!mapped) return [];
  return Object.entries(mapped).map(([label, value]) => ({
    label,
    value: Number.isFinite(Number(value)) ? Number(value) : 0,
  }));
}

export function buildReportQuery({
  entity,
  metric,
  groupBy,
  startDate,
  endDate,
}: {
  entity: ReportEntity;
  metric: ReportMetric;
  groupBy: string;
  startDate: string;
  endDate: string;
}) {
  return {
    entity,
    metric,
    ...(metric === "count" ? {} : { metricField: "value" }),
    groupBy,
    dateRange: { start: startDate, end: endDate },
  };
}
