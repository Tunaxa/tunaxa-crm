import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Topbar } from "./Topbar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/dashboard" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("../context/AppContext", () => ({
  useApp: () => ({ user: { id: "u_1", name: "Test", role: "owner" }, logout: vi.fn() }),
}));
vi.mock("../i18n", () => ({ default: { language: "en" } }));

function renderTopbar(unreadCount: number, notificationOpen: boolean) {
  return renderToStaticMarkup(
    <Topbar
      mobile={false}
      onOpenMobile={vi.fn()}
      onOpenSearch={vi.fn()}
      onOpenQuickCreate={vi.fn()}
      onOpenEcosystem={vi.fn()}
      onOpenNotifications={vi.fn()}
      notificationOpen={notificationOpen}
      unreadCount={unreadCount}
      profile={false}
      onToggleProfile={vi.fn()}
      theme={false}
      onToggleTheme={vi.fn()}
      onToggleLanguage={vi.fn()}
    />,
  );
}

describe("Topbar notification bell", () => {
  it("exposes unread count, popup semantics and an aria-hidden badge", () => {
    const html = renderTopbar(120, true);
    expect(html).toContain('aria-label="Notifications, 120 unread"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('class="notification-count" aria-hidden="true"');
    expect(html).toContain("99+");
  });

  it("omits the badge when the unread count is zero", () => {
    const html = renderTopbar(0, false);
    expect(html).toContain('aria-label="Notifications"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("notification-count");
  });
});
