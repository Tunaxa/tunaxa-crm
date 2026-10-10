import { json } from "../../lib/api";
import { parseNotification } from "./notificationModel";
type Request = (path: string, options: RequestInit) => Promise<unknown>;
export async function readNotification(id: string, request: Request) {
  const saved = parseNotification(await request(`/notifications/${encodeURIComponent(id)}/read`, json("PATCH", {})));
  if (saved.id !== id || !saved.read) throw new Error("Read update not confirmed");
  return saved;
}
export async function readAllNotifications(request: Request) {
  const result = await request("/notifications/read-all", json("POST", {})) as { updated?: number };
  if (!result || !Number.isInteger(result.updated) || Number(result.updated) < 0) throw new Error("Read update not confirmed");
  return Number(result.updated);
}
