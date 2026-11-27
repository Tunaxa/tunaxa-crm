import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation, InboxPage, ThreadList } from "./InboxPage";
import { MailEditor } from "./MailEditor";
import {
  buildThreads,
  filterThreads,
  parseMessage,
  type Message,
} from "./inboxModel";

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

const sentThreadList = (rows: Message[]) =>
  renderToStaticMarkup(
    <ThreadList
      threads={filterThreads(buildThreads(rows), "Sent", "")}
      selectedKey={null}
      onSelect={vi.fn()}
    />,
  );

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

  it("shows outbound Saved and Queued conversations under the Sent filter", () => {
    const html = sentThreadList([
      parseMessage({
        id: "saved",
        channel: "Email",
        direction: "Outbound",
        to: "customer@example.com",
        subject: "Saved update",
        body: "Email provider not configured; this email was saved.",
        status: "Saved",
        createdAt: "2026-10-10T10:00:00Z",
      }),
      parseMessage({
        id: "queued",
        channel: "Email",
        direction: "Outbound",
        to: "customer@example.com",
        subject: "Queued update",
        body: "Delivery pending.",
        status: "Queued",
        createdAt: "2026-10-10T11:00:00Z",
      }),
    ]);
    expect(html).toContain("Saved update");
    expect(html).toContain("Queued update");
    expect(html).toContain(">Saved<");
    expect(html).toContain(">Queued<");
  });

  it("renders accessible delivered, opened and clicked indicators with real counts", () => {
    const tracked = parseMessage({
      id: "tracked",
      channel: "Email",
      direction: "Outbound",
      to: "customer@example.com",
      subject: "Proposal",
      body: "<script>alert(1)</script>",
      createdAt: "2026-10-10T09:00:00Z",
      status: "Sent",
      read: true,
      deliveredAt: "2026-10-10T09:00:00Z",
      openedAt: "2026-10-10T10:00:00Z",
      openCount: 3,
      clickedAt: "2026-10-10T11:00:00Z",
      clickCount: 2,
    });
    const html = renderToStaticMarkup(
      <Conversation
        thread={buildThreads([tracked])[0]}
        editable={false}
        disabled={false}
      />,
    );
    expect(html).toContain("Delivered");
    expect(html).toContain("Opened");
    expect(html).toContain("Clicked");
    expect(html).toContain('dateTime="2026-10-10T10:00:00Z"');
    expect(html).toContain('dateTime="2026-10-10T11:00:00Z"');
    expect(html).toContain('dateTime="2026-10-10T09:00:00Z"');
    expect(html).toContain('aria-label="Opened');
    expect(html).toContain('aria-label="Clicked');
    expect(html).toContain(">3×</");
    expect(html).toContain(">2×</");
    expect(html).not.toContain(">1×<");
    expect(html).not.toContain('title="');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("mouse-pointer-click");
  });

  it("never fabricates a count badge for a single open or click", () => {
    const tracked = parseMessage({
      id: "tracked_once",
      channel: "Email",
      direction: "Outbound",
      to: "customer@example.com",
      subject: "Proposal",
      body: "Hello",
      createdAt: "2026-10-10T09:00:00Z",
      status: "Sent",
      read: true,
      deliveredAt: "2026-10-10T09:00:00Z",
      openedAt: "2026-10-10T10:00:00Z",
      openCount: 1,
      clickedAt: "2026-10-10T11:00:00Z",
      clickCount: 1,
    });
    const html = renderToStaticMarkup(
      <ThreadList
        threads={buildThreads([tracked])}
        selectedKey={null}
        onSelect={vi.fn()}
      />,
    );
    expect(html).toContain("Opened");
    expect(html).toContain("Clicked");
    expect(html).not.toContain(">1×<");
    expect(html).not.toContain(">0×<");
  });

  it("hides inbound-only and Failed conversations from the Sent filter", () => {
    const html = sentThreadList([
      parseMessage({
        id: "inbound",
        channel: "Email",
        direction: "Inbound",
        from: "customer@example.com",
        to: "me@example.com",
        subject: "Inbound only",
        body: "Please reply",
        status: "Received",
        createdAt: "2026-10-10T09:00:00Z",
      }),
      parseMessage({
        id: "failed",
        channel: "Email",
        direction: "Outbound",
        to: "customer@example.com",
        subject: "Failed only",
        body: "Not delivered",
        status: "Failed",
        createdAt: "2026-10-10T09:30:00Z",
      }),
    ]);
    expect(html).not.toContain("Inbound only");
    expect(html).not.toContain("Failed only");
    expect(html).not.toContain(">Failed<");
  });
});
