import { api, json } from "../../lib/api";
import { parseMentionUsers, type MentionUser } from "./mentionModel";
import { parseNotification } from "./notificationModel";

export async function readNotification(id: string) {
  const encoded = encodeURIComponent(id);
  const saved = parseNotification(
    await api(`/notifications/${encoded}/read`, json("PATCH", {})),
  );
  if (saved.id !== id || !saved.read) {
    throw new Error("Read update not confirmed");
  }
  return saved;
}

export async function readAllNotifications() {
  const result = await api<{ updated?: number }>(
    "/notifications/read-all",
    json("POST", {}),
  );
  if (!result || !Number.isInteger(result.updated) || Number(result.updated) < 0) {
    throw new Error("Read update not confirmed");
  }
  return Number(result.updated);
}

export async function searchMentionableUsers(
  query: string,
  signal: AbortSignal,
): Promise<MentionUser[]> {
  const encoded = encodeURIComponent(query);
  const result = await api(`/notifications/mentionable?q=${encoded}`, { signal });
  return parseMentionUsers(result);
}
