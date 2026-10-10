import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation, InboxPage, ThreadList } from "./InboxPage";
import { MailEditor } from "./MailEditor";
import { buildThreads, parseMessage, type Message } from "./inboxModel";
const mocks = vi.hoisted(() => ({ role: "Owner", state: { messages: [] as Message[], loading: false, writing: false, error: "", readError: "", load: vi.fn(), markRead: vi.fn(), send: vi.fn(), remove: vi.fn() } }));
vi.mock("./useInbox", () => ({ useInbox: () => mocks.state }));
vi.mock("../../../context/AppContext", () => ({ useApp: () => ({ user: { role: mocks.role }, toast: vi.fn() }) }));
const message = parseMessage({ id: "one", channel: "Email", direction: "Inbound", from: "customer@example.com", to: "me@example.com", subject: "Proposal", body: "<script>alert(1)</script>\nHello", createdAt: "bad", read: false, status: "Received" });
describe("inbox presentation", () => {
  beforeEach(() => { mocks.role = "Owner"; mocks.state.messages = [message]; mocks.state.loading = false; mocks.state.writing = false; mocks.state.error = ""; mocks.state.readError = ""; });
  it("renders the conversation list beside a conversation selection area", () => {
    const html = renderToStaticMarkup(<InboxPage />); expect(html).toContain('aria-label="Email conversations"'); expect(html).toContain('aria-label="Selected conversation"'); expect(html).toContain("Select a conversation"); expect(html).toContain("Search conversations");
  });
  it("preserves filters and compose for users allowed to send", () => { const html = renderToStaticMarkup(<InboxPage />); for (const control of ["Compose", "Unread", "Sent", "Tracked"]) expect(html).toContain(control); });
  it("keeps viewer access read only", () => { mocks.role = "viewer"; expect(renderToStaticMarkup(<InboxPage />)).not.toContain(">Compose</button>"); });
  it("shows stale-data errors without claiming the inbox is empty", () => { mocks.state.error = "Could not load the complete inbox."; const html = renderToStaticMarkup(<InboxPage />); expect(html).toContain("Showing the last loaded conversations"); expect(html).toContain("Retry inbox"); expect(html).not.toContain("No conversations yet"); });
  it("shows loading without a false empty state", () => { mocks.state.messages = []; mocks.state.loading = true; const html = renderToStaticMarkup(<InboxPage />); expect(html).toContain("Loading inbox"); expect(html).not.toContain("No conversations yet"); });
  it("marks the active conversation and its unread state", () => { const threads = buildThreads([message]); const html = renderToStaticMarkup(<ThreadList threads={threads} selectedKey={threads[0].key} onSelect={vi.fn()} />); expect(html).toContain('aria-pressed="true"'); expect(html).toContain("Unread"); });
  it("renders stored HTML as text and handles invalid timestamps", () => { const html = renderToStaticMarkup(<Conversation thread={buildThreads([message])[0]} editable={false} disabled={false} onDelete={vi.fn()} />); expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>"); expect(html).toContain("Date unavailable"); expect(html).not.toContain("Delete message</button>"); });
  it("shows provider status without inventing successful delivery", () => { const saved = { ...message, status: "Saved" }; expect(renderToStaticMarkup(<Conversation thread={buildThreads([saved])[0]} editable disabled onDelete={vi.fn()} />)).toContain("Email provider not configured"); });
  it("places a reply editor with a fixed recipient directly in the conversation", () => { const html = renderToStaticMarkup(<MailEditor reply recipient="customer@example.com" subject="Re: Proposal" onSend={vi.fn()} onSent={vi.fn()} />); expect(html).toContain("Reply inline"); expect(html).toContain("customer@example.com"); expect(html).toContain("Send reply"); expect(html).toContain("textarea"); expect(html).not.toContain('type="email"'); });
});
