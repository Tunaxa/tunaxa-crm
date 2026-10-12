import { describe, expect, it } from "vitest";
import { buildReportQuery, normalizeReportResults } from "./reportBuilder";

describe("custom report builder", () => {
  it("normalizes common report response shapes", () => {
    expect(
      normalizeReportResults(
        { rows: [{ stage: "Won", count: 4 }, { stage: "Lost", count: 2 }] },
        "stage",
      ),
    ).toEqual([
      { label: "Won", value: 4 },
      { label: "Lost", value: 2 },
    ]);

    expect(
      normalizeReportResults({ results: { Website: 8, Referral: 3 } }, "source"),
    ).toEqual([
      { label: "Website", value: 8 },
      { label: "Referral", value: 3 },
    ]);
  });

  it("turns non-numeric result values into zero", () => {
    expect(
      normalizeReportResults([{ label: "Unassigned", value: "unknown" }], "owner"),
    ).toEqual([{ label: "Unassigned", value: 0 }]);
  });

  it("builds count and value aggregation requests", () => {
    expect(
      buildReportQuery({
        entity: "leads",
        metric: "count",
        groupBy: "source",
        startDate: "2026-09-01",
        endDate: "2026-09-23",
      }),
    ).toEqual({
      entity: "leads",
      metric: "count",
      groupBy: "source",
      dateRange: { start: "2026-09-01", end: "2026-09-23" },
    });

    expect(
      buildReportQuery({
        entity: "deals",
        metric: "sum",
        groupBy: "stage",
        startDate: "2026-09-01",
        endDate: "2026-09-23",
      }),
    ).toMatchObject({ metric: "sum", metricField: "value" });
  });
});
