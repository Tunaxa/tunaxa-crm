import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationDrawer, NotificationList } from "./NotificationCenter";
import { parseNotification, type NotificationPage } from "./notificationModel";
import type { NotificationState } from "./useNotifications";

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));

const row = parseNotification({
  id: "n_1",
  title: "<script>bad</script>",
  message: "<img onerror=bad>",
  type: "mention",
  read: false,
  createdAt: "bad",
  link: "/contacts/c_1",
});

function state(page: NotificationPage | null, error = ""): NotificationState {
  return {
    page,
    loading: false,
    error,
    writing: false,
    load: vi.fn(async () => {}),
    markRead: vi.fn(async () => {}),
    markAll: vi.fn(async () => {}),
  };
}

function render(page: NotificationPage | null, canManage: boolean, error = "") {
  return renderToStaticMarkup(
    <NotificationDrawer
      state={state(page, error)}
      unreadOnly={false}
      onUnreadOnlyChange={vi.fn()}
      offset={0}
      onOffsetChange={vi.fn()}
      onClose={vi.fn()}
      canManage={canManage}
    />,
  );
}

const page: NotificationPage = { notifications: [row], unreadCount: 1, total: 1 };

describe("notification drawer presentation", () => {
  it("escapes notification text and offers confirmed read actions", () => {
    const html = render(page, true);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("Mark read");
    expect(html).toContain("Mark all read");
    expect(html).toContain("Open record");
    expect(html).toContain("Date unavailable");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });

  it("keeps viewers read-only", () => {
    const html = render(page, false);
    expect(html).not.toContain("Mark read");
    expect(html).not.toContain("Mark all read");
    expect(html).toContain("Open record");
  });

  it("does not expose unsupported record links", () => {
    const html = renderToStaticMarkup(
      <NotificationList
        rows={[parseNotification({ ...row, link: "https://evil.example" })]}
        disabled={false}
        canManage
        onRead={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(html).not.toContain("Open record");
  });

  it("uses live regions for errors and empty states", () => {
    expect(render(null, true, "Unavailable")).toContain('role="alert"');
    expect(
      render({ notifications: [], unreadCount: 0, total: 0 }, true),
    ).toContain("No notifications.");
  });
});
