import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationCenter, NotificationList } from "./NotificationCenter";
import { MentionInput } from "../../components/MentionInput";
import { parseNotification } from "./notificationModel";
const state = vi.hoisted(() => ({ user: { id: "u_1" } as { id: string } | null, data: { page: { notifications: [], unreadCount: 120, total: 120 } as unknown, loading: false, writing: false, error: "", load: vi.fn(), markRead: vi.fn(), markAll: vi.fn() } }));
vi.mock("../../context/AppContext", () => ({ useApp: () => ({ user: state.user }) }));
vi.mock("./useNotifications", () => ({ useNotifications: () => state.data }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
const row = parseNotification({ id: "n_1", title: "<script>bad</script>", message: "<img onerror=bad>", read: false, createdAt: "bad", link: "/contacts/c_1" });
describe("notification and mention presentation", () => {
  it("shows an accessible unread count with a compact visual badge", () => { state.user = { id: "u_1" }; state.data.error = ""; const html = renderToStaticMarkup(<NotificationCenter />); expect(html).toContain("120 unread"); expect(html).toContain("99+"); expect(html).toContain('aria-haspopup="dialog"'); });
  it("does not claim a known unread count when the service fails", () => { state.data.error = "Unavailable"; const html = renderToStaticMarkup(<NotificationCenter />); expect(html).toContain("Notifications unavailable"); expect(html).not.toContain("99+"); state.data.error = ""; });
  it("renders nothing after logout", () => { state.user = null; expect(renderToStaticMarkup(<NotificationCenter />)).toBe(""); state.user = { id: "u_1" }; });
  it("escapes notification text and offers confirmed read actions", () => { const html = renderToStaticMarkup(<NotificationList rows={[row]} disabled={false} onRead={vi.fn()} onOpen={vi.fn()} />); expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<img onerror"); expect(html).toContain("Mark read"); expect(html).toContain("Open record"); expect(html).toContain("Date unavailable"); });
  it("does not expose unsupported record links or repeated read actions", () => { const html = renderToStaticMarkup(<NotificationList rows={[{ ...row, read: true, link: "https://evil.example" }]} disabled={false} onRead={vi.fn()} onOpen={vi.fn()} />); expect(html).not.toContain("Open record"); expect(html).not.toContain("Mark read"); });
  it("labels the input, renders mention chips and explains missing suggestions", () => { const html = renderToStaticMarkup(<MentionInput label="Comment" value="Hello @sarah@example.com" onChange={vi.fn()} />); expect(html).toContain("Mentions in this message"); expect(html).toContain("mention-chip"); expect(html).toContain("suggestions are not available yet"); expect(html).toContain('for="'); });
  it("keeps read-only mention inputs disabled", () => { const html = renderToStaticMarkup(<MentionInput label="Comment" value="" onChange={vi.fn()} disabled />); expect(html).toMatch(/<textarea[^>]*disabled/); });
});
