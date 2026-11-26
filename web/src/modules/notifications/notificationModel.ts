import {
  containsDangerousKey,
  hasOwn,
  notificationTarget,
  safeFields,
} from "../../components/records/urlSecurity";

export type Notification = {
  id: string;
  title: string;
  message: string;
  type: string;
  link: string | null;
  read: boolean;
  createdAt: string;
};

export type NotificationPage = {
  notifications: Notification[];
  unreadCount: number;
  total: number;
};

export { notificationTarget };

export function parseNotification(value: unknown): Notification {
  if (containsDangerousKey(value)) throw new Error("Invalid notification");
  const row = safeFields(value);
  if (
    typeof row.id !== "string" ||
    !row.id ||
    typeof row.title !== "string" ||
    typeof row.read !== "boolean" ||
    !hasOwn(row, "id")
  ) {
    throw new Error("Invalid notification");
  }
  const link = notificationTarget(row.link);
  const createdAt =
    typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt))
      ? row.createdAt
      : "";
  return {
    id: row.id,
    title: row.title,
    message: typeof row.message === "string" ? row.message : "",
    type: typeof row.type === "string" ? row.type : "system",
    link,
    read: row.read,
    createdAt,
  };
}

export function parseNotificationPage(value: unknown): NotificationPage {
  if (containsDangerousKey(value)) throw new Error("Invalid notification page");
  const page = safeFields(value);
  if (
    !hasOwn(page, "notifications") ||
    !Array.isArray(page.notifications) ||
    !Number.isInteger(page.unreadCount) ||
    Number(page.unreadCount) < 0 ||
    !Number.isInteger(page.total) ||
    Number(page.total) < 0
  ) {
    throw new Error("Invalid notification page");
  }
  const notifications = page.notifications.map(parseNotification);
  const seen = Object.create(null) as Record<string, true>;
  for (const notification of notifications) {
    if (hasOwn(seen, notification.id)) throw new Error("Invalid notification page");
    seen[notification.id] = true;
  }
  if (
    notifications.length > Number(page.total) ||
    Number(page.unreadCount) > Number(page.total)
  ) {
    throw new Error("Invalid notification page");
  }
  return {
    notifications,
    unreadCount: Number(page.unreadCount),
    total: Number(page.total),
  };
}

export function notificationError(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  if (status === 404) return "Notifications are not available yet.";
  if (status === 401) return "Sign in again to load notifications.";
  if (status === 403) return "You do not have access to these notifications.";
  return "Could not load or update notifications. Please retry.";
}

export function notificationDate(value: string): string {
  return Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString()
    : "Date unavailable";
}
