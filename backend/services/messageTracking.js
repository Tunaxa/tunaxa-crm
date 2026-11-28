import { query } from "../db/pg.js";

const TRACKING_TYPES = ["email_open", "email_click"];

function nonNegativeCount(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), Number.MAX_SAFE_INTEGER);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : "";
}

async function trackingSummaries(messageIds, workspaceId) {
  const summaries = new Map();
  const ids = [...new Set(messageIds.filter((id) => typeof id === "string" && id))];
  if (!ids.length || typeof workspaceId !== "string" || !workspaceId) return summaries;

  try {
    const result = await query(
      `SELECT metadata->>'messageId' AS message_id,
              COUNT(*) FILTER (WHERE type = 'email_open')::int AS open_count,
              MAX(metadata->>'openedAt') AS opened_at,
              COUNT(*) FILTER (WHERE type = 'email_click')::int AS click_count,
              MAX(metadata->>'clickedAt') AS clicked_at
         FROM activities
        WHERE (workspace_id = $1 OR ($1 = 'default' AND workspace_id IS NULL))
          AND type = ANY($2::text[])
          AND metadata->>'messageId' = ANY($3::text[])
        GROUP BY metadata->>'messageId'`,
      [workspaceId, TRACKING_TYPES, ids],
    );
    for (const row of result.rows) {
      if (typeof row.message_id !== "string") continue;
      summaries.set(row.message_id, {
        openCount: nonNegativeCount(row.open_count),
        openedAt: validTimestamp(row.opened_at),
        clickCount: nonNegativeCount(row.click_count),
        clickedAt: validTimestamp(row.clicked_at),
      });
    }
  } catch (error) {
    console.error("[messageTracking] could not load tracking summaries:", error?.message || error);
  }
  return summaries;
}

export async function hydrateMessageTracking(rows, workspaceId) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const summaries = await trackingSummaries(
    rows.map((row) => row?.id),
    workspaceId,
  );
  return rows.map((row) => {
    const summary = summaries.get(row?.id) || {};
    return {
      ...row,
      openedAt: summary.openedAt || "",
      openCount: summary.openCount ?? 0,
      clickedAt: summary.clickedAt || "",
      clickCount: summary.clickCount ?? 0,
      deliveredAt: validTimestamp(row?.deliveredAt),
    };
  });
}

export async function contactEmailAnalytics({ contactId, messages = [], workspaceId } = {}) {
  const contact = typeof contactId === "string" ? contactId : "";
  const scope = typeof workspaceId === "string" && workspaceId ? workspaceId : "";
  const empty = {
    contactId: contact,
    sentEmails: 0,
    openedEmails: 0,
    totalOpens: 0,
    clickCount: 0,
    openRate: 0,
    lastOpenedAt: "",
  };
  if (!scope) return empty;

  const rows = Array.isArray(messages) ? messages : [];
  const scopedRows = rows.filter((row) => {
    const rowScope = row?.workspaceId ?? row?.workspace_id;
    return typeof rowScope === "string" && rowScope === scope;
  });
  const summaries = await trackingSummaries(
    scopedRows.map((row) => row?.id),
    scope,
  );

  let sentEmails = 0;
  let openedEmails = 0;
  let totalOpens = 0;
  let clickCount = 0;
  let lastOpenedAt = "";

  for (const row of scopedRows) {
    const id = row?.id;
    if (typeof id !== "string" || !id) continue;
    const summary = summaries.get(id) || {};
    const openCount = nonNegativeCount(summary.openCount ?? row?.openCount);
    const clicks = nonNegativeCount(summary.clickCount ?? row?.clickCount);
    const openedAt = validTimestamp(summary.openedAt ?? row?.openedAt);

    sentEmails += 1;
    if (openCount > 0 || openedAt) openedEmails += 1;
    totalOpens += openCount;
    clickCount += clicks;
    if (openedAt && (!lastOpenedAt || Date.parse(openedAt) > Date.parse(lastOpenedAt))) {
      lastOpenedAt = openedAt;
    }
  }

  sentEmails = nonNegativeCount(sentEmails);
  openedEmails = Math.min(nonNegativeCount(openedEmails), sentEmails);
  totalOpens = nonNegativeCount(totalOpens);
  clickCount = nonNegativeCount(clickCount);
  const openRate = sentEmails > 0 ? Math.round((openedEmails / sentEmails) * 1000) / 10 : 0;

  return {
    contactId: contact,
    sentEmails,
    openedEmails,
    totalOpens,
    clickCount,
    openRate,
    lastOpenedAt,
  };
}
