import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation, InboxPage, ThreadList } from "./InboxPage";
import { MailEditor } from "./MailEditor";
import { buildThreads, parseMessage, type Message } from "./inboxModel";

const mocks = vi.hoisted(() => ({
  role: "Owner",
  state: {
    messages: [] as Message[],
    loading: false,
    writing: false,
    error: "",
    readError: "",
    load: vi.fn(),
    markRead: vi.fn(),
    markUnread: vi.fn(),
    send: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("./useInbox", () => ({ useInbox: () => mocks.state }));
vi.mock("../../../context/AppContext", () => ({
  useApp: () => ({ user: { role: mocks.role }, toast: vi.fn() }),
}));

const message = parseMessage({
  id: "one",
  channel: "Email",
  direction: "Inbound",
  from: "customer@example.com",
  to: "me@example.com",
  subject: "Proposal",
  body: "<script>alert(1)</script>\nHello",
  createdAt: "bad",
  read: false,
  status: "Received",
});

describe("inbox presentation", () => {
  beforeEach(() => {
    mocks.role = "Owner";
    mocks.state.messages = [message];
    mocks.state.loading = false;
    mocks.state.writing = false;
    mocks.state.error = "";
    mocks.state.readError = "";
  });

  it("renders the conversation list beside a selected conversation area", () => {
    const html = renderToStaticMarkup(<InboxPage />);
    expect(html).toContain('aria-label="Email conversations"');
    expect(html).toContain('aria-label="Selected conversation"');
    expect(html).toContain("Select a conversation");
    expect(html).toContain("Search conversations");
  });

  it("preserves filters and write controls for users allowed to send", () => {
    const html = renderToStaticMarkup(
      <Conversation
        thread={buildThreads([message])[0]}
        editable
        disabled={false}
        onDelete={vi.fn()}
        onMarkRead={vi.fn()}
        onMarkUnread={vi.fn()}
      />,
    );
    for (const control of ["Mark read", "Mark unread", "Delete message"]) {
      expect(html).toContain(control);
    }
    expect(renderToStaticMarkup(<InboxPage />)).toContain("Compose");
  });

  it("keeps viewer access read only", () => {
    mocks.role = "viewer";
    const page = renderToStaticMarkup(<InboxPage />);
    expect(page).not.toContain(">Compose</button>");
    expect(page).toContain("You have read-only inbox access.");
    const html = renderToStaticMarkup(
      <Conversation
        thread={buildThreads([message])[0]}
        editable={false}
        disabled={false}
      />,
    );
    for (const control of ["Mark read", "Mark unread", "Delete message"]) {
      expect(html).not.toContain(control);
    }
  });

  it("shows stale-data errors without claiming the inbox is empty", () => {
    mocks.state.error = "Could not load the complete inbox.";
    const html = renderToStaticMarkup(<InboxPage />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Showing the last loaded conversations");
    expect(html).toContain("Retry inbox");
    expect(html).not.toContain("No conversations yet");
  });

  it("shows loading and sending indicators without a false empty state", () => {
    mocks.state.messages = [];
    mocks.state.loading = true;
    const loading = renderToStaticMarkup(<InboxPage />);
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Loading inbox");
    expect(loading).not.toContain("No conversations yet");
    mocks.state.loading = false;
    mocks.state.writing = true;
    expect(renderToStaticMarkup(<InboxPage />)).toContain("Sending…");
  });

  it("marks the active conversation and its unread state", () => {
    const threads = buildThreads([message]);
    const html = renderToStaticMarkup(
      <ThreadList
        threads={threads}
        selectedKey={threads[0].key}
        onSelect={vi.fn()}
      />,
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Unread");
  });

  it("renders stored HTML as text and handles invalid timestamps", () => {
    const html = renderToStaticMarkup(
      <Conversation
        thread={buildThreads([message])[0]}
        editable={false}
        disabled={false}
      />,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Date unavailable");
    expect(html).not.toContain("Delete message</button>");
    expect(html).not.toContain('datetime="bad"');
  });

  it("places a reply editor with a fixed recipient in the conversation", () => {
    const html = renderToStaticMarkup(
      <MailEditor
        reply
        recipient="customer@example.com"
        subject="Re: Proposal"
        onSend={vi.fn()}
        onSent={vi.fn()}
      />,
    );
    expect(html).toContain("Reply inline");
    expect(html).toContain("customer@example.com");
    expect(html).toContain("Send reply");
    expect(html).toContain("textarea");
    expect(html).not.toContain('type="email"');
  });
});
