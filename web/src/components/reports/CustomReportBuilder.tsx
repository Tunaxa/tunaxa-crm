import { useState, type FormEvent } from "react";
import { api, json } from "../../lib/api";
import { Icon } from "../Icon";
import { money } from "../ui";
import {
  buildReportQuery,
  normalizeReportResults,
  reportGroupFields,
  type ReportEntity,
  type ReportMetric,
  type ReportResultRow,
} from "./reportBuilder";

const entities: { value: ReportEntity; label: string }[] = [
  { value: "deals", label: "Deals" },
  { value: "contacts", label: "Contacts" },
  { value: "leads", label: "Leads" },
];

const metrics: { value: ReportMetric; label: string }[] = [
  { value: "count", label: "Count" },
  { value: "sum", label: "Sum of Value" },
  { value: "average", label: "Average" },
];

function inputDate(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function initialDates() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 29);
  return { start: inputDate(start), end: inputDate(end) };
}

export function CustomReportBuilder() {
  const dates = initialDates();
  const [entity, setEntity] = useState<ReportEntity>("deals");
  const [metric, setMetric] = useState<ReportMetric>("count");
  const [groupBy, setGroupBy] = useState(reportGroupFields.deals[0].value);
  const [startDate, setStartDate] = useState(dates.start);
  const [endDate, setEndDate] = useState(dates.end);
  const [rows, setRows] = useState<ReportResultRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const entityLabel = entities.find((item) => item.value === entity)?.label || entity;
  const metricLabel = metrics.find((item) => item.value === metric)?.label || metric;

  function chooseEntity(nextEntity: ReportEntity) {
    setEntity(nextEntity);
    setGroupBy(reportGroupFields[nextEntity][0].value);
    setRows(null);
    setError("");
  }

  async function runReport(event: FormEvent) {
    event.preventDefault();
    if (!startDate || !endDate) {
      setError("Choose a start and end date.");
      return;
    }
    if (startDate > endDate) {
      setError("The start date must be before the end date.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const query = buildReportQuery({
        entity,
        metric,
        groupBy,
        startDate,
        endDate,
      });
      const response = await api<unknown>(
        "/reports/query",
        json("POST", query),
      );
      setRows(normalizeReportResults(response, groupBy));
    } catch (requestError) {
      setRows(null);
      setError((requestError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const maximum = Math.max(1, ...(rows || []).map((row) => Math.abs(row.value)));
  const formatValue = (value: number) =>
    metric === "count"
      ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
      : money(value);

  return (
    <section className="surface custom-report-builder" aria-labelledby="report-builder-title">
      <header className="custom-report-head">
        <div className="custom-report-heading">
          <span>
            <Icon name="reports" size={20} />
          </span>
          <div>
            <h2 id="report-builder-title">Build Report</h2>
            <p>Create a grouped report using your CRM data.</p>
          </div>
        </div>
      </header>

      <form className="custom-report-form" onSubmit={runReport}>
        <label className="custom-report-step">
          <span className="custom-report-step-number">1</span>
          <span className="field">
            <span>Choose entity</span>
            <select
              value={entity}
              onChange={(event) => chooseEntity(event.target.value as ReportEntity)}
            >
              {entities.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </span>
        </label>

        <label className="custom-report-step">
          <span className="custom-report-step-number">2</span>
          <span className="field">
            <span>Choose metric</span>
            <select
              value={metric}
              onChange={(event) => {
                setMetric(event.target.value as ReportMetric);
                setRows(null);
                setError("");
              }}
            >
              {metrics.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </span>
        </label>

        <label className="custom-report-step">
          <span className="custom-report-step-number">3</span>
          <span className="field">
            <span>Group by</span>
            <select
              value={groupBy}
              onChange={(event) => {
                setGroupBy(event.target.value);
                setRows(null);
                setError("");
              }}
            >
              {reportGroupFields[entity].map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </span>
        </label>

        <div className="custom-report-step custom-report-dates">
          <span className="custom-report-step-number" aria-hidden="true">4</span>
          <div role="group" aria-label="Choose date range">
            <label className="field">
              <span>Start date</span>
              <input
                type="date"
                value={startDate}
                max={endDate}
                onChange={(event) => {
                  setStartDate(event.target.value);
                  setRows(null);
                  setError("");
                }}
              />
            </label>
            <label className="field">
              <span>End date</span>
              <input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(event) => {
                  setEndDate(event.target.value);
                  setRows(null);
                  setError("");
                }}
              />
            </label>
          </div>
        </div>

        <div className="custom-report-submit">
          <button className="btn primary" type="submit" disabled={busy}>
            <Icon name="play" /> {busy ? "Running…" : "Run Report"}
          </button>
        </div>
      </form>

      {error ? (
        <div className="custom-report-error" role="alert">
          <Icon name="warning" />
          <div>
            <b>Report could not be generated</b>
            <span>{error}</span>
          </div>
        </div>
      ) : null}

      {rows !== null ? (
        <div className="custom-report-results" aria-live="polite">
          <header>
            <div>
              <h3>Report results</h3>
              <p>
                {metricLabel} of {entityLabel.toLowerCase()} grouped by {" "}
                {reportGroupFields[entity]
                  .find((item) => item.value === groupBy)
                  ?.label.toLowerCase() || groupBy}
              </p>
            </div>
            <BadgeCount count={rows.length} />
          </header>

          {rows.length ? (
            <div className="custom-report-output">
              <div className="custom-report-chart" role="img" aria-label={`${metricLabel} bar chart`}>
                {rows.map((row, index) => (
                  <div className="custom-report-bar-row" key={`${row.label}-${index}`}>
                    <span title={row.label}>{row.label}</span>
                    <div className="custom-report-bar-track">
                      <i
                        style={{
                          width: `${row.value === 0 ? 0 : Math.max(3, (Math.abs(row.value) / maximum) * 100)}%`,
                        }}
                      />
                    </div>
                    <b>{formatValue(row.value)}</b>
                  </div>
                ))}
              </div>

              <div className="custom-report-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Group</th>
                      <th>{metricLabel}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={`${row.label}-${index}`}>
                        <td>{row.label}</td>
                        <td>{formatValue(row.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="custom-report-empty">
              <Icon name="reports" size={24} />
              <b>No results found</b>
              <span>Try a different date range or grouping.</span>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function BadgeCount({ count }: { count: number }) {
  return <span className="badge badge-blue">{count} groups</span>;
}
