// @mention parsing and notification dispatch.
//
// Rich-text bodies (ticket comments, notes) can tag teammates with `@handle`,
// where a handle is either a username/display slug (`@sarah`, `@sarah.connor`)
// or a full email address (`@sarah.connor@cyberdyne.com`). Mentioning a user
// files a single `mention` notification on their timeline, resolved strictly
// within the author's workspace so a comment can never reach another tenant.

import { readDb } from "../store.js";
import { createNotification } from "./notifications.js";

// Two alternatives, email first so an address is not clipped to its local part:
//   1. name@domain.tld
//   2. a dotted/hyphenated handle whose segments cannot start or end with a
//      separator, so trailing sentence punctuation ("@john.") is not captured.
const MENTION_REGEX =
  /@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g;

const EXCERPT_LENGTH = 120;

function normalize(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

/** "Sarah Connor" -> "sarah.connor", so @sarah.connor resolves to a name. */
function nameSlug(name) {
  return normalize(name).replace(/\s+/g, ".");
}

/** Unique, lowercased handles referenced in `text`, in first-seen order. */
export function extractMentionHandles(text) {
  if (!text) return [];
  const seen = new Set();
  const handles = [];
  for (const match of String(text).matchAll(MENTION_REGEX)) {
    const handle = match[1].toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    handles.push(handle);
  }
  return handles;
}

/**
 * Resolve mentioned handles to workspace users. Matching is by username, email,
 * full name, or dot-slugged name. Deduplicates by user id so tagging the same
 * person twice yields one recipient.
 */
export async function resolveMentionedUsers(text, workspaceId) {
  const handles = extractMentionHandles(text);
  if (handles.length === 0) return [];

  const db = await readDb();
  const users = (db.users || []).filter(
    (user) => !workspaceId || user.workspaceId === workspaceId,
  );

  const matched = new Map();
  for (const handle of handles) {
    for (const user of users) {
      if (matched.has(user.id)) continue;
      const candidates = new Set(
        [
          normalize(user.username),
          normalize(user.email),
          normalize(user.name),
          nameSlug(user.name),
        ].filter(Boolean),
      );
      if (candidates.has(handle)) matched.set(user.id, user);
    }
  }
  return [...matched.values()];
}

/**
 * Parse `text`, resolve recipients in the workspace, and file a `mention`
 * notification for each (excluding the author). Returns the created records.
 *
 * Never throws into the caller: a notification failure must not fail the write
 * that carried the text. Per-recipient creation is individually guarded.
 */
export async function processMentions({
  text,
  authorUser,
  workspaceId,
  resourceType,
  resourceId,
  resourceTitle = null,
}) {
  let recipients = [];
  try {
    recipients = await resolveMentionedUsers(text, workspaceId);
  } catch (error) {
    console.error("[mentions] resolution failed:", error?.message || error);
    return [];
  }

  const body = String(text == null ? "" : text);
  const message = body.length > EXCERPT_LENGTH ? `${body.slice(0, EXCERPT_LENGTH - 3)}...` : body;
  const created = [];

  for (const recipient of recipients) {
    if (authorUser && recipient.id === authorUser.id) continue;
    try {
      const notification = await createNotification({
        userId: recipient.id,
        workspaceId: recipient.workspaceId || workspaceId,
        type: "mention",
        title: `${authorUser?.name || "A teammate"} mentioned you`,
        message,
        link: resourceId ? `/${resourceType}/${resourceId}` : null,
        metadata: {
          resourceType,
          resourceId,
          resourceTitle,
          authorId: authorUser?.id || null,
          authorName: authorUser?.name || null,
        },
        createdBy: authorUser?.id || null,
      });
      created.push(notification);
    } catch (error) {
      console.error("[mentions] failed to create notification:", error?.message || error);
    }
  }
  return created;
}
