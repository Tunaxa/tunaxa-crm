export type Notification = { id: string; title: string; message: string; type: string; link: string | null; read: boolean; createdAt: string };
export type NotificationPage = { notifications: Notification[]; unreadCount: number; total: number };
export function parseNotification(value: unknown): Notification {
  const row = value as Record<string, unknown>;
  if (!row || typeof row.id !== "string" || !row.id || typeof row.title !== "string" || typeof row.read !== "boolean") throw new Error("Invalid notification");
  return { id: row.id, title: row.title, message: typeof row.message === "string" ? row.message : "", type: typeof row.type === "string" ? row.type : "system", link: typeof row.link === "string" ? row.link : null, read: row.read, createdAt: typeof row.createdAt === "string" ? row.createdAt : "" };
}
export function parseNotificationPage(value: unknown): NotificationPage {
  const page = value as Record<string, unknown>;
  if (!page || !Array.isArray(page.notifications) || !Number.isInteger(page.unreadCount) || Number(page.unreadCount) < 0 || !Number.isInteger(page.total) || Number(page.total) < 0) throw new Error("Invalid notification page");
  const notifications = page.notifications.map(parseNotification);
  if (new Set(notifications.map(row => row.id)).size !== notifications.length || notifications.length > Number(page.total)) throw new Error("Invalid notification page");
  return { notifications, unreadCount: Number(page.unreadCount), total: Number(page.total) };
}
// Only established record routes are accepted. Never follow external links or
// the pending backend's /ticket/:id links before a matching UI route exists.
export function notificationTarget(link: string | null) {
  if (!link || /[\\\s%?#]/u.test(link)) return null;
  return /^\/(?:contacts|leads|companies|deals|invoices|quotes|contracts)\/[A-Za-z0-9_-]+$/u.test(link) ? link : null;
}
export function notificationError(error: unknown) {
  const status = (error as { status?: number })?.status;
  if (status === 404) return "Notifications are not available yet. The notification service needs to be enabled.";
  if (status === 401) return "Sign in again to load notifications.";
  if (status === 403) return "You do not have access to these notifications.";
  return "Could not load or update notifications. Please retry.";
}
export function notificationDate(value: string) { return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Date unavailable"; }
