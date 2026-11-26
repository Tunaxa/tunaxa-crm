import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Topbar } from "./Topbar";

const notificationCss = readFileSync(
  new URL("../modules/notifications/notifications.css", import.meta.url),
  "utf8",
);

function cssBlock(marker: string) {
  const start = notificationCss.indexOf(marker);
  if (start < 0) return "";
  const open = notificationCss.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < notificationCss.length; index += 1) {
    if (notificationCss[index] === "{") depth += 1;
    if (notificationCss[index] === "}") {
      depth -= 1;
      if (depth === 0) return notificationCss.slice(start, index + 1);
    }
  }
  return "";
}

function centeredDeclarations(block: string) {
  const match = block.match(
    /\.topbar \.notification-btn\.notification-trigger\s*\{([^}]*)\}/,
  );
  return match?.[1] ?? "";
}

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

  it("centers the bell icon globally and at 768px or below", () => {
    const globalRule = centeredDeclarations(
      cssBlock(".topbar .notification-btn.notification-trigger"),
    );
    const mobileRule = centeredDeclarations(
      cssBlock("@media (max-width: 768px)"),
    );
    for (const declarations of [globalRule, mobileRule]) {
      expect(declarations).toMatch(/display:\s*inline-flex/);
      expect(declarations).toMatch(/align-items:\s*center/);
      expect(declarations).toMatch(/justify-content:\s*center/);
      expect(declarations).toMatch(/position:\s*relative/);
      expect(declarations).toMatch(/padding:\s*0/);
    }
    expect(notificationCss).toMatch(
      /\.notification-count\s*\{[^}]*position:\s*absolute/,
    );
  });
});
