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
