import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailComposerDrawer } from "./EmailComposerDrawer";
const state = vi.hoisted(() => ({ role: "member" }));
vi.mock("../../../context/AppContext", () => ({ useApp: () => ({ user: { role: state.role }, toast: vi.fn() }) }));
vi.mock("../../../components/ui", () => ({ Drawer: ({ children, title }: { children: React.ReactNode; title: string }) => <aside role="dialog" aria-label={title}>{children}</aside> }));
const render = () => renderToStaticMarkup(<EmailComposerDrawer recipient="customer@example.com" contact="Customer" onClose={vi.fn()} onSent={vi.fn()} />);
describe("record email drawer", () => {
  it("prefills the recipient and exposes template and message fields", () => {
    state.role = "member"; const html = render();
    expect(html).toContain('role="dialog"'); expect(html).toContain('value="customer@example.com"');
    expect(html).toContain("Email template"); expect(html).toContain("textarea"); expect(html).toContain("Send email");
  });
  it("does not offer unsupported attachment or formatting controls", () => {
    state.role = "member"; const html = render();
    expect(html).toContain("sent as plain text"); expect(html).not.toContain('type="file"'); expect(html).not.toContain("contenteditable");
  });
  it("disables the editor for a viewer", () => {
    state.role = "viewer"; const html = render();
    expect(html).toContain("read-only email access"); expect(html).toMatch(/<textarea[^>]*disabled/);
  });
});
