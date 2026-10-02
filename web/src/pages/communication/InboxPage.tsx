export function InboxPage() {
  const { toast } = useApp();

  const [messages, setMessages] = useState<Row[]>([]);
  const [selectedThread, setSelectedThread] = useState<Row[]>([]);
  const [activeFilter, setActiveFilter] = useState<
    "All" | "Unread" | "Sent" | "Tracked"
  >("All");

  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  const [compose, setCompose] = useState(false);
  const [sending, setSending] = useState(false);

  const [templates, setTemplates] = useState<Row[]>([]);
  const [templateId, setTemplateId] = useState("");
  const {
  register,
  handleSubmit,
  reset,
  watch,
  setValue,
} = useForm<{
  channel: string;
  to: string;
  subject: string;
  body: string;
}>({
  defaultValues: {
    channel: "Email",
    to: "",
    subject: "",
    body: "",
  },
});

  const [draft, setDraft] = useState<Row>({
    id: "",
    channel: "Email",
    to: "",
    subject: "",
    body: "",
  });

  async function loadMessages(targetPage = page) {
    setLoading(true);

    try {
      const response = await api<{
        items: Row[];
        total: number;
        page: number;
        limit: number;
        hasMore: boolean;
      }>(
        `/messages?type=email&page=${targetPage}&limit=${limit}`,
      );

      setMessages(response.items || []);
      setTotal(response.total || 0);
      setHasMore(Boolean(response.hasMore));

      if (response.items?.length && !selectedThread.length) {
        setSelectedThread([response.items[0]]);
      }
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMessages(page);
  }, [page]);

  useEffect(() => {
    api<Row[]>("/templates")
      .then(setTemplates)
      .catch(() => {});
  }, []);

  function applyTemplate(id: string) {
    setTemplateId(id);

    const template = templates.find((item) => item.id === id);

    if (!template) return;

    setDraft((prev) => ({
      ...prev,
      subject: template.subject || "",
      body: template.body || "",
    }));
  }

  function getThreadKey(message: Row) {
    return `${String(message.to || "").toLowerCase()}::${String(
      message.subject || "",
    )
      .trim()
      .toLowerCase()}`;
  }

  const threads = Array.from(
    messages.reduce((map, message) => {
      const key = getThreadKey(message);

      if (!map.has(key)) {
        map.set(key, []);
      }

      map.get(key)!.push(message);

      return map;
    }, new Map<string, Row[]>()),
  ).map(([key, thread]) => ({
    key,
    messages: thread.sort(
      (a, b) =>
        new Date(a.createdAt || 0).getTime() -
        new Date(b.createdAt || 0).getTime(),
    ),
  }));

  const filteredThreads = threads.filter(({ messages: thread }) => {
    if (!thread.length) return false;

    if (activeFilter === "Unread") {
      return thread.some((message) => !message.read);
    }

    if (activeFilter === "Sent") {
      return thread.some(
        (message) =>
          message.direction === "Outbound" ||
          message.status === "Sent",
      );
    }

    if (activeFilter === "Tracked") {
      return thread.some(
        (message) =>
          Boolean(message.openedAt) || Boolean(message.clickedAt),
      );
    }

    return true;
  });

  function openThread(thread: Row[]) {
    setSelectedThread(thread);

    const unread = thread.filter((message) => !message.read);

    unread.forEach((message) => {
      api(`/messages/${message.id}`, json("PATCH", { read: true })).catch(
        () => {},
      );
    });

    setMessages((current) =>
      current.map((message) =>
        thread.some((item) => item.id === message.id)
          ? { ...message, read: true }
          : message,
      ),
    );
  }

  async function sendMessage(message: Row) {
    setSending(true);

    try {
      const saved = await api<Row>(
        "/messages/send",
        json("POST", {
          id: message.id,
          channel: "Email",
          to: message.to,
          subject: message.subject,
          body: message.body,
          contact: message.contact,
        }),
      );

      setCompose(false);
      setTemplateId("");
      setDraft({
        id: "",
        channel: "Email",
        to: "",
        subject: "",
        body: "",
      });

      await loadMessages(page);

      setSelectedThread([saved]);

      toast(
        saved.deliveredAt
          ? "Message sent"
          : saved.status === "Failed"
            ? "Delivery failed"
            : "Message saved for later",
      );
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setSending(false);
    }
  }

  async function deleteMessage(message: Row) {
    if (!confirm("Delete this message?")) return;

    try {
      await api(`/messages/${message.id}`, json("DELETE"));

      setSelectedThread([]);

      await loadMessages(page);

      toast("Message deleted");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  const selectedLastMessage =
    selectedThread[selectedThread.length - 1] || null;

  return (
    <div className="page">
      <PageHeader
        title="Unified Inbox"
        description="Manage your email conversations from one place."
      >
        <button
          className="btn primary"
          onClick={() => {
            setDraft({
              id: "",
              channel: "Email",
              to: "",
              subject: "",
              body: "",
            });
            setTemplateId("");
            setCompose(true);
          }}
        >
          <Icon name="send" /> Compose
        </button>
      </PageHeader>

      <section
        className="surface"
        style={{
          overflow: "hidden",
          minHeight: "650px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* FILTERS */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "14px 18px",
            borderBottom: "1px solid var(--border, #e5e7eb)",
          }}
        >
          {(["All", "Unread", "Sent", "Tracked"] as const).map((filter) => (
            <button
              key={filter}
              className={
                activeFilter === filter
                  ? "btn primary compact"
                  : "btn secondary compact"
              }
              onClick={() => setActiveFilter(filter)}
            >
              {filter}
            </button>
          ))}

          <span
            style={{
              marginLeft: "auto",
              fontSize: "12px",
              opacity: 0.65,
            }}
          >
            {total} email{total !== 1 ? "s" : ""}
          </span>
        </div>

        {/* SPLIT PANE */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "360px minmax(0, 1fr)",
            minHeight: "580px",
            flex: 1,
          }}
        >
          {/* LEFT PANE */}
          <aside
            style={{
              borderRight: "1px solid var(--border, #e5e7eb)",
              overflowY: "auto",
            }}
          >
            {loading ? (
              <div style={{ padding: "30px", textAlign: "center" }}>
                Loading conversations…
              </div>
            ) : filteredThreads.length ? (
              filteredThreads.map(({ key, messages: thread }) => {
                const last = thread[thread.length - 1];
                const unread = thread.some((message) => !message.read);
                const active = selectedThread.some(
                  (message) => message.id === last.id,
                );

                return (
                  <button
                    key={key}
                    onClick={() => openThread(thread)}
                    style={{
                      width: "100%",
                      display: "block",
                      textAlign: "left",
                      padding: "16px",
                      border: "0",
                      borderBottom:
                        "1px solid var(--border, #e5e7eb)",
                      background: active
                        ? "rgba(59, 130, 246, 0.08)"
                        : "transparent",
                      cursor: "pointer",
                      fontWeight: unread ? 700 : 400,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "12px",
                      }}
                    >
                      <span>
                        {last.to || "Unknown recipient"}
                      </span>

                      <time
                        style={{
                          fontSize: "11px",
                          opacity: 0.6,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {last.createdAt
                          ? new Date(
                              last.createdAt,
                            ).toLocaleDateString()
                          : ""}
                      </time>
                    </div>

                    <div
                      style={{
                        marginTop: "6px",
                        fontSize: "13px",
                        fontWeight: unread ? 700 : 500,
                      }}
                    >
                      {last.subject || "No subject"}
                    </div>

                    <div
                      style={{
                        marginTop: "5px",
                        fontSize: "12px",
                        opacity: 0.65,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {last.body || "No content"}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: "8px",
                        marginTop: "9px",
                        alignItems: "center",
                      }}
                    >
                      {unread ? (
                        <Badge tone="blue">Unread</Badge>
                      ) : null}

                      {last.status ? (
                        <Badge
                          tone={
                            last.status === "Sent"
                              ? "green"
                              : last.status === "Failed"
                                ? "red"
                                : "amber"
                          }
                        >
                          {last.status}
                        </Badge>
                      ) : null}

                      {last.openedAt || last.clickedAt ? (
                        <span
                          style={{
                            fontSize: "11px",
                            opacity: 0.7,
                          }}
                        >
                          <Icon name="eye" /> Tracked
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })
            ) : (
              <div style={{ padding: "40px 20px" }}>
                <Empty
                  icon="inbox"
                  title="No conversations"
                  text="No email conversations match this filter."
                />
              </div>
            )}

            {/* PAGINATION */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px",
                borderTop: "1px solid var(--border, #e5e7eb)",
                position: "sticky",
                bottom: 0,
                background: "var(--surface, white)",
              }}
            >
              <button
                className="btn secondary compact"
                disabled={page <= 1 || loading}
                onClick={() => {
                  setPage((current) => Math.max(1, current - 1));
                  setSelectedThread([]);
                }}
              >
                Previous
              </button>

              <span style={{ fontSize: "12px", opacity: 0.65 }}>
                Page {page}
              </span>

              <button
                className="btn secondary compact"
                disabled={!hasMore || loading}
                onClick={() => {
                  setPage((current) => current + 1);
                  setSelectedThread([]);
                }}
              >
                Next
              </button>
            </div>
          </aside>

          {/* RIGHT PANE */}
          <main
            style={{
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {selectedThread.length ? (
              <>
                <header
                  style={{
                    padding: "18px 22px",
                    borderBottom:
                      "1px solid var(--border, #e5e7eb)",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "16px",
                  }}
                >
                  <div>
                    <h3 style={{ margin: 0 }}>
                      {selectedLastMessage?.subject || "No subject"}
                    </h3>

                    <small style={{ opacity: 0.65 }}>
                      {selectedLastMessage?.to}
                    </small>
                  </div>

                  {selectedLastMessage ? (
                    <button
                      className="icon-btn danger-link"
                      title="Delete message"
                      onClick={() =>
                        deleteMessage(selectedLastMessage)
                      }
                    >
                      <Icon name="trash" />
                    </button>
                  ) : null}
                </header>

                <div
                  style={{
                    flex: 1,
                    overflowY: "auto",
                    padding: "22px",
                  }}
                >
                  {selectedThread.map((message) => {
                    const outbound =
                      message.direction === "Outbound";

                    return (
                      <article
                        key={message.id}
                        style={{
                          marginBottom: "18px",
                          maxWidth: "85%",
                          marginLeft: outbound ? "auto" : "0",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "11px",
                            opacity: 0.6,
                            marginBottom: "6px",
                          }}
                        >
                          {outbound ? "You" : message.to} ·{" "}
                          {message.createdAt
                            ? new Date(
                                message.createdAt,
                              ).toLocaleString()
                            : ""}
                        </div>

                        <div
                          style={{
                            padding: "16px",
                            borderRadius: "12px",
                            background: outbound
                              ? "rgba(59, 130, 246, 0.10)"
                              : "var(--surface-muted, #f5f5f5)",
                            border:
                              "1px solid var(--border, #e5e7eb)",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {message.body || "No content"}
                        </div>

                        <div
                          style={{
                            display: "flex",
                            gap: "8px",
                            marginTop: "6px",
                            fontSize: "11px",
                            opacity: 0.65,
                          }}
                        >
                          {message.status ? (
                            <span>{message.status}</span>
                          ) : null}

                          {message.openedAt ? (
                            <span>
                              <Icon name="eye" /> Opened{" "}
                              {message.openCount || 1}×
                            </span>
                          ) : null}

                          {message.clickedAt ? (
                            <span>
                              Clicked {message.clickCount || 1}×
                            </span>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>

                <footer
                  style={{
                    padding: "14px 20px",
                    borderTop:
                      "1px solid var(--border, #e5e7eb)",
                    display: "flex",
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    className="btn primary"
                    disabled={sending}
                    onClick={() =>
                      sendMessage({
                        ...selectedLastMessage,
                        id: "",
                        body: "",
                      })
                    }
                  >
                    <Icon name="send" /> Reply
                  </button>
                </footer>
              </>
            ) : (
              <div
                style={{
                  flex: 1,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Empty
                  icon="inbox"
                  title="Select a conversation"
                  text="Choose an email thread from the list."
                />
              </div>
            )}
          </main>
        </div>
      </section>

      {/* COMPOSE */}
      {compose ? (
        <Drawer
          title="New email"
          subtitle="Compose a new email message."
          onClose={() => {
  setCompose(false);
  setTemplateId("");
  reset();
}}
          footer={
            <button
              className="btn secondary"
              onClick={() => {
                setCompose(false);
                setTemplateId("");
              }}
            >
              Cancel
            </button>
          }
        >
          <div className="drawer-form">
            {templates.length ? (
              <label className="field">
                <span>Template</span>

                <select
                  value={templateId}
                  onChange={(e) => applyTemplate(e.target.value)}
                >
                  <option value="">No template</option>

                  {templates.map((template) => (
                    <option
                      key={template.id}
                      value={template.id}
                    >
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="field">
              <span>Recipient *</span>

              <input
                type="email"
                value={draft.to || ""}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    to: e.target.value,
                  }))
                }
                placeholder="recipient@example.com"
              />
            </label>

            <label className="field">
              <span>Subject</span>

              <input
                type="text"
                value={draft.subject || ""}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    subject: e.target.value,
                  }))
                }
                placeholder="Email subject"
              />
            </label>

            <label className="field">
              <span>Message *</span>

              <textarea
                value={draft.body || ""}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    body: e.target.value,
                  }))
                }
                placeholder="Write your email…"
                rows={8}
              />
            </label>

            <button
              className="btn primary"
              disabled={!draft.to || !draft.body || sending}
              onClick={() => sendMessage(draft)}
            >
              {sending ? "Sending…" : "Send email"}
            </button>
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}

