import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Empty, Modal, PageHeader } from "../../../components/ui";
import { Icon } from "../../../components/Icon";
import { useApp } from "../../../context/AppContext";
import { buildThreads, canSendEmail, deliveryLabel, filterThreads, inboxFilters, isOutbound, replySubject, type InboxFilter, type Message, type Thread } from "./inboxModel";
import { useInbox } from "./useInbox";
import { MailEditor } from "./MailEditor";
import "./inbox.css";

const dateLabel = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Date unavailable";
function Status({ message }: { message: Message }) {
  return <>{message.status && <Badge tone={message.status === "Sent" ? "green" : message.status === "Failed" ? "red" : "amber"}>{message.status}</Badge>}{(message.openedAt || message.clickedAt) && <small>Tracked</small>}</>;
}
export function ThreadList({ threads, selectedKey, onSelect }: { threads: Thread[]; selectedKey: string | null; onSelect: (thread: Thread) => void }) {
  return <div className="inbox-thread-list">{threads.map(thread => <button type="button" className={`inbox-thread ${thread.key === selectedKey ? "active" : ""}`} key={thread.key} aria-pressed={thread.key === selectedKey} onClick={() => onSelect(thread)}>
    <span className="inbox-thread-heading"><strong>{thread.peer || "Unknown counterpart"}</strong>{thread.unread && <Badge tone="blue">Unread</Badge>}</span>
    <span className="inbox-thread-subject">{thread.subject}</span><span className="inbox-preview">{thread.latest.body || "No message content"}</span>
    <span className="inbox-thread-meta"><time dateTime={Number.isFinite(Date.parse(thread.latest.createdAt)) ? thread.latest.createdAt : undefined}>{dateLabel(thread.latest.createdAt)}</time><span>{thread.messages.length} message{thread.messages.length === 1 ? "" : "s"}</span><Status message={thread.latest} /></span>
  </button>)}</div>;
}
export function Conversation({ thread, editable, disabled, onDelete }: { thread: Thread; editable: boolean; disabled: boolean; onDelete: (message: Message) => void }) {
  return <><header className="inbox-conversation-header"><h2>{thread.subject}</h2><p>{thread.peer || "Counterpart unavailable"}</p></header>
    <div className="inbox-message-list" aria-label="Conversation messages">{thread.messages.map(message => <article key={message.id} className={`inbox-message ${isOutbound(message) ? "outbound" : "inbound"}`}>
      <header><strong>{isOutbound(message) ? "You" : message.from || "Unknown sender"}</strong><time dateTime={Number.isFinite(Date.parse(message.createdAt)) ? message.createdAt : undefined}>{dateLabel(message.createdAt)}</time></header>
      <p className="inbox-message-body">{message.body || "No message content"}</p>
      <footer><Status message={message} />{message.status === "Saved" && <small>Email provider not configured; this email was saved.</small>}{message.status === "Queued" && <small>Delivery pending.</small>}{message.status === "Failed" && <small>Delivery failed.</small>}
        {editable && <button type="button" className="btn secondary compact danger-link" disabled={disabled} onClick={() => onDelete(message)} aria-label={`Delete message from ${dateLabel(message.createdAt)}`}><Icon name="trash" />Delete message</button>}
      </footer>
    </article>)}</div></>;
}

export function InboxPage() {
  const state = useInbox(); const { user, toast } = useApp();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<InboxFilter>("All"), [query, setQuery] = useState("");
  const [page, setPage] = useState(1), [compose, setCompose] = useState(false);
  const composeBusy = useRef(false);
  const threads = useMemo(() => buildThreads(state.messages), [state.messages]);
  const filtered = useMemo(() => filterThreads(threads, filter, query), [threads, filter, query]);
  const selected = threads.find(thread => thread.key === selectedKey);
  const pages = Math.max(1, Math.ceil(filtered.length / 20)), currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * 20, currentPage * 20);
  const editable = canSendEmail(user?.role), available = !state.loading && !state.error && !state.writing;
  useEffect(() => { if (selected && editable) void state.markRead(selected.messages); }, [selected, editable, state.markRead]);
  function sent(message: Message) { toast(deliveryLabel(message)); setSelectedKey(buildThreads([message])[0].key); }
  const closeCompose = () => { if (!composeBusy.current) setCompose(false); };
  async function remove(message: Message) {
    if (!editable || !available || !confirm("Delete this message?")) return;
    try { await state.remove(message.id); toast("Message deleted"); }
    catch (failure) { toast((failure as Error).message, "error"); }
  }
  return <div className="page unified-inbox-page">
    <PageHeader title="Unified Inbox" description="Read email conversations and reply without leaving the inbox.">
      <button type="button" className="btn secondary" disabled={state.loading || state.writing} onClick={() => void state.load()}><Icon name="refresh" />Refresh</button>
      {editable && <button type="button" className="btn primary" disabled={!available} onClick={() => setCompose(true)}><Icon name="send" />Compose</button>}
    </PageHeader>
    {state.loading && <p role="status">{state.messages.length ? "Refreshing inbox…" : "Loading inbox…"}</p>}
    {state.error && <div className="inbox-notice" role="alert"><p>{state.error}</p>{state.messages.length > 0 && <p>Showing the last loaded conversations.</p>}<button type="button" className="btn secondary compact" disabled={state.loading || state.writing} onClick={() => void state.load()}>Retry inbox</button></div>}
    {state.readError && <div className="inbox-notice" role="alert"><p>{state.readError}</p>{selected && <button type="button" className="btn secondary compact" onClick={() => void state.markRead(selected.messages)}>Retry marking read</button>}</div>}
    <section className="surface inbox-layout">
      <aside className="inbox-sidebar" aria-label="Email conversations">
        <label className="field inbox-search"><span>Search conversations</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="Recipient, subject or message" /></label>
        <div className="inbox-filters" role="group" aria-label="Conversation filters">{inboxFilters.map(value => <button type="button" key={value} className={`btn ${filter === value ? "primary" : "secondary"} compact`} aria-pressed={filter === value} onClick={() => { setFilter(value); setPage(1); }}>{value}</button>)}</div>
        <p className="inbox-count">{filtered.length} conversations · {state.messages.length} emails</p>
        <ThreadList threads={visible} selectedKey={selected?.key || null} onSelect={thread => setSelectedKey(thread.key)} />
        {!visible.length && !state.loading && !state.error && <Empty icon="inbox" title={state.messages.length ? "No matching conversations" : "No conversations yet"} text="Your email conversations will appear here." />}
        {pages > 1 && <nav className="inbox-pagination" aria-label="Conversation pages"><button type="button" className="btn secondary compact" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage} of {pages}</span><button type="button" className="btn secondary compact" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Next</button></nav>}
      </aside>
      <section className="inbox-conversation" aria-label="Selected conversation">
        {selected ? <><Conversation thread={selected} editable={editable} disabled={!available} onDelete={message => void remove(message)} />
          {editable ? selected.peer ? <MailEditor key={selected.key} reply recipient={selected.peer} subject={replySubject(selected.latest.subject)} contact={selected.latest.contact} disabled={!available} onSend={state.send} onSent={sent} /> : <p className="inbox-notice">A sender or recipient email is required to reply to this conversation.</p> : <p className="inbox-notice">You have read-only inbox access.</p>}
        </> : <Empty icon="inbox" title="Select a conversation" text="Choose a conversation from the list to read its messages." />}
      </section>
    </section>
    {compose && <Modal title="Compose email" onClose={closeCompose}><MailEditor disabled={!editable || !available} onSend={state.send} onSent={message => { sent(message); setCompose(false); }} onBusy={value => { composeBusy.current = value; }} /></Modal>}
  </div>;
}
