/**
 * Weekly report email digest generator.
 *
 * Turns the row array returned by `runReportQuery()` (`{ group, value, count }`)
 * into the HTML + plaintext body of a digest email, and derives the summary
 * metrics the schedule worker logs alongside the delivery result.
 *
 * Every value that reaches the template is HTML-escaped first: `group` is a
 * user-supplied column value, and report rows are otherwise untrusted content
 * rendered into a mail client.
 */

const EMAIL_FROM_BRAND = "Tunaxa CRM";

// Mirrors the shape the schedules store; a report may omit any of them.
export const DEFAULT_SCHEDULE = {
  enabled: false,
  frequency: 'weekly',
  dayOfWeek: 'monday',
  time: '08:00',
  recipients: [],
  format: 'summary',
  lastSentAt: null,
  includeTable: true,
};

/** Fields whose aggregated sum is a money amount rather than a plain number. */
const CURRENCY_FIELDS = new Set([
  'value',
  'amount',
  'total',
  'revenue',
  'price',
  'cost',
  'mrr',
  'arr',
  'dealValue',
  'target',
]);

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** The aggregation definition: `report.query` with a flat `report` fallback. */
export function resolveReportQuery(report = {}) {
  const source = report.query && typeof report.query === 'object' ? report.query : report;
  return {
    entity: source.entity || report.entity || null,
    groupBy: source.groupBy || source.group_by || null,
    metric: String(source.metric || 'count').toLowerCase(),
    field: source.field || null,
    dateRange: source.dateRange || source.date_range || null,
    dateField: source.dateField || source.date_field || null,
  };
}

/** Human label for the aggregation, e.g. `Sum of value by stage`. */
export function describeQuery(report = {}) {
  const q = resolveReportQuery(report);
  const entity = q.entity ? String(q.entity) : 'records';
  const metric = q.metric === 'count' ? 'Count' : q.metric === 'avg' ? 'Average' : 'Total';
  const of = q.metric !== 'count' && q.field ? ` of ${q.field}` : '';
  const by = q.groupBy ? ` by ${q.groupBy}` : '';
  return `${metric}${of} of ${entity}${by}`;
}

/** True when the aggregated metric is a currency amount. */
function isCurrencyReport(report = {}) {
  const q = resolveReportQuery(report);
  if (q.metric === 'count') return false;
  return CURRENCY_FIELDS.has(String(q.field || '').toLowerCase());
}

function formatNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatCurrency(value, currency = 'USD') {
  const num = Number(value);
  if (!Number.isFinite(num)) return '$0';
  try {
    return num.toLocaleString('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2,
    });
  } catch {
    return `$${formatNumber(num)}`;
  }
}

function formatPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0%';
  return `${num.toFixed(1)}%`;
}

function formatDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** Describes the date window the aggregation covered, if one was applied. */
function describeDateRange(report = {}) {
  const q = resolveReportQuery(report);
  const range = q.dateRange;
  if (!range || typeof range !== 'object') return 'All time';
  const from = range.from ? String(range.from) : null;
  const to = range.to ? String(range.to) : null;
  if (from && to) return `${from} to ${to}`;
  if (from) return `From ${from}`;
  if (to) return `Up to ${to}`;
  return 'All time';
}

/**
 * Summary metrics for a report result set.
 *
 * @param {object} report - Saved report definition
 * @param {Array<{ group: string, value: number, count: number }>} rows
 * @param {object} [options]
 * @param {string} [options.currency='USD']
 * @param {Date|string} [options.generatedAt]
 * @returns {{
 *   totalCount: number, totalValue: number, averageValue: number,
 *   groupCount: number, topGroup: object|null, currency: boolean,
 *   period: string, generatedAt: string
 * }}
 */
export function summarizeReportData(report = {}, rows = [], options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const currencyReport = isCurrencyReport(report);

  let totalCount = 0;
  let totalValue = 0;
  for (const row of list) {
    totalCount += Number(row?.count ?? 0) || 0;
    totalValue += Number(row?.value ?? 0) || 0;
  }
  totalValue = Math.round(totalValue * 100) / 100;

  const topGroup = list.length ? list[0] : null;

  return {
    totalCount,
    totalValue,
    averageValue: list.length ? Math.round((totalValue / list.length) * 100) / 100 : 0,
    groupCount: list.length,
    topGroup,
    currency: currencyReport,
    period: describeDateRange(report),
    generatedAt: options.generatedAt
      ? options.generatedAt instanceof Date
        ? options.generatedAt.toISOString()
        : String(options.generatedAt)
      : new Date().toISOString(),
  };
}

/** Rows annotated with their share of the total, for the digest table. */
export function withPercentages(rows = [], totalValue) {
  const list = Array.isArray(rows) ? rows : [];
  const base = Number(totalValue) || 0;
  return list.map((row) => {
    const value = Number(row?.value ?? 0) || 0;
    return {
      group: String(row?.group ?? 'Unassigned'),
      value,
      count: Number(row?.count ?? 0) || 0,
      percent: base > 0 ? (value / base) * 100 : 0,
    };
  });
}

function formatMetricValue(value, { currency }) {
  return currency ? formatCurrency(value) : formatNumber(value);
}

function renderKpiCard(label, value, sub) {
  return `      <td class="kpi" width="33%" style="padding:12px 8px;">
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;">${escapeHtml(label)}</div>
        <div style="font-size:22px;font-weight:600;color:#111827;padding-top:4px;">${escapeHtml(value)}</div>
        ${sub ? `<div style="font-size:12px;color:#6b7280;padding-top:2px;">${escapeHtml(sub)}</div>` : ''}
      </td>`;
}

function renderTableRows(tableRows, { currency }) {
  return tableRows
    .map(
      (row, index) => `        <tr style="background:${index % 2 === 1 ? '#f9fafb' : '#ffffff'};">
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;color:#111827;">${escapeHtml(row.group)}</td>
          <td align="right" style="padding:8px 10px;border-bottom:1px solid #e5e7eb;color:#111827;font-variant-numeric:tabular-nums;">${escapeHtml(formatMetricValue(row.value, { currency }))}</td>
          <td align="right" style="padding:8px 10px;border-bottom:1px solid #e5e7eb;color:#111827;font-variant-numeric:tabular-nums;">${escapeHtml(formatNumber(row.count))}</td>
          <td align="right" style="padding:8px 10px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-variant-numeric:tabular-nums;">${escapeHtml(formatPercent(row.percent))}</td>
        </tr>`
    )
    .join('\n');
}

function renderTextTable(tableRows, { currency }) {
  const header = ['Group / Category', 'Value / Total', 'Count', '% of Total'];
  const body = tableRows.map((row) => [
    row.group,
    formatMetricValue(row.value, { currency }),
    formatNumber(row.count),
    formatPercent(row.percent),
  ]);
  const widths = header.map((label, index) =>
    Math.max(label.length, ...body.map((cells) => String(cells[index]).length))
  );
  const line = (cells) =>
    cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ');
  const rule = widths.map((width) => '-'.repeat(width)).join('  ');
  return [line(header), rule, ...body.map(line)].join('\n');
}

/**
 * Renders the subject, HTML body and plaintext fallback for a report digest.
 *
 * @param {object} report - Saved report definition (name, entity, query, schedule)
 * @param {Array<{ group: string, value: number, count: number }>} reportData - Rows from runReportQuery()
 * @param {object} [options]
 * @param {Date|string} [options.generatedAt] - Execution timestamp stamped into the footer
 * @param {string} [options.currency='USD'] - ISO currency for money metrics
 * @param {string} [options.workspaceName='Tunaxa'] - Workspace attribution for the footer
 * @param {string} [options.dashboardUrl] - Deep link back into the CRM
 * @returns {{ subject: string, html: string, text: string, metrics: object }}
 */
export function generateReportEmailContent(report = {}, reportData = [], options = {}) {
  const schedule = { ...DEFAULT_SCHEDULE, ...(report.schedule || {}) };
  const name = String(report.name || report.title || 'Untitled Report');
  const generatedAt = options.generatedAt ? new Date(options.generatedAt) : new Date();
  const workspaceName = options.workspaceName || 'Tunaxa';
  const metrics = summarizeReportData(report, reportData, {
    currency: options.currency,
    generatedAt,
  });
  const currencyReport = metrics.currency;
  const tableRows = withPercentages(reportData, metrics.totalValue);
  const dashboardUrl = options.dashboardUrl || '';
  const includeTable = schedule.includeTable !== false && tableRows.length > 0;
  const generatedLabel = formatDate(generatedAt);

  const subject = `Weekly Report: ${name} - ${metrics.totalCount} record${metrics.totalCount === 1 ? '' : 's'}`;

  const kpis = [
    renderKpiCard('Total Records', formatNumber(metrics.totalCount), describeQuery(report)),
    renderKpiCard(
      currencyReport ? 'Total Value' : 'Total Metric',
      formatMetricValue(metrics.totalValue, { currency: currencyReport }),
      `${metrics.groupCount} group${metrics.groupCount === 1 ? '' : 's'}`
    ),
    renderKpiCard(
      currencyReport ? 'Average per Group' : 'Average per Group',
      formatMetricValue(metrics.averageValue, { currency: currencyReport }),
      metrics.topGroup ? `Top: ${metrics.topGroup.group}` : 'No data'
    ),
  ].join('\n');

  const tableHtml = includeTable
    ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px;">
        <thead>
          <tr>
            <th align="left" style="padding:8px 10px;border-bottom:2px solid #d1d5db;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Group / Category</th>
            <th align="right" style="padding:8px 10px;border-bottom:2px solid #d1d5db;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Value / Total</th>
            <th align="right" style="padding:8px 10px;border-bottom:2px solid #d1d5db;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Count</th>
            <th align="right" style="padding:8px 10px;border-bottom:2px solid #d1d5db;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">% of Total</th>
          </tr>
        </thead>
        <tbody>
${renderTableRows(tableRows, { currency: currencyReport })}
        </tbody>
      </table>`
    : '';

  const emptyNotice =
    tableRows.length === 0
      ? `<p style="margin:16px 0;padding:12px 14px;background:#f3f4f6;border-left:3px solid #9ca3af;color:#4b5563;font-size:13px;">
           No records matched this report for the selected period. Widen the date range or adjust the filters to see results.
         </p>`
      : '';

  const html = `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="background:#111827;padding:20px 24px;">
                <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#9ca3af;">${escapeHtml(EMAIL_FROM_BRAND)}</div>
                <h1 style="margin:6px 0 0 0;font-size:20px;font-weight:600;color:#ffffff;">${escapeHtml(name)}</h1>
                <div style="font-size:13px;color:#d1d5db;padding-top:6px;">
                  Weekly digest &middot; ${escapeHtml(metrics.period)} &middot; Generated ${escapeHtml(generatedLabel)}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 24px 4px 24px;">
                <div style="font-size:13px;color:#374151;">
                  ${escapeHtml(describeQuery(report))} &middot; Workspace: ${escapeHtml(workspaceName)}
                </div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:12px;">
                  <tr>
${kpis}
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 24px 20px 24px;">
${emptyNotice}
${tableHtml}
              </td>
            </tr>
            <tr>
              <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 24px;font-size:12px;color:#6b7280;">
                Sent by ${escapeHtml(workspaceName)} via ${escapeHtml(EMAIL_FROM_BRAND)} &middot; Executed ${escapeHtml(generatedLabel)}
                ${dashboardUrl ? `<br /><a href="${escapeHtml(dashboardUrl)}" style="color:#2563eb;">View this report in ${escapeHtml(EMAIL_FROM_BRAND)}</a>` : ''}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textLines = [
    `${EMAIL_FROM_BRAND} - Weekly Report`,
    '='.repeat(52),
    `Report:     ${name}`,
    `Workspace:  ${workspaceName}`,
    `Summary:    ${describeQuery(report)}`,
    `Period:     ${metrics.period}`,
    `Generated:  ${generatedLabel}`,
    '',
    'Highlights',
    '-'.repeat(52),
    `Total Records:      ${formatNumber(metrics.totalCount)}`,
    `Total ${currencyReport ? 'Value' : 'Metric'}:     ${formatMetricValue(metrics.totalValue, { currency: currencyReport })}`,
    `Average per Group:  ${formatMetricValue(metrics.averageValue, { currency: currencyReport })}`,
    `Groups:             ${formatNumber(metrics.groupCount)}`,
    `Top Group:          ${metrics.topGroup ? `${metrics.topGroup.group} (${formatMetricValue(metrics.topGroup.value, { currency: currencyReport })})` : 'n/a'}`,
    '',
  ];

  if (tableRows.length === 0) {
    textLines.push(
      'No records matched this report for the selected period.',
      'Widen the date range or adjust the filters to see results.',
      ''
    );
  } else if (includeTable) {
    textLines.push('Breakdown', '-'.repeat(52), renderTextTable(tableRows, { currency: currencyReport }), '');
  }

  textLines.push('-'.repeat(52));
  textLines.push(`Sent by ${workspaceName} via ${EMAIL_FROM_BRAND} at ${generatedLabel}`);
  if (dashboardUrl) textLines.push(`Dashboard: ${dashboardUrl}`);

  return { subject, html, text: textLines.join('\n'), metrics };
}
