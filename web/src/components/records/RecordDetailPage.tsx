import { useParams, useNavigate } from "react-router-dom";
import { useApp } from "../../context/AppContext";
import { useRef, useState, useEffect } from "react";
import { api, json } from "../../lib/api";
import { Icon } from "../Icon";
import { LifecycleStage } from "../LifecycleStage";
import { InlineEditField } from "../InlineEditField";
import { contractSummaryValue, ContractDetails } from "../contracts/ContractDetails";
import { money, Avatar, Badge, Empty } from "../ui";
import { GenerateInvoiceButton } from "../quotes/GenerateInvoiceButton";
import { AssociatedRecords } from "../AssociatedRecords";
import { ContactSequenceEnrollment } from "../../modules/marketing/sequences/ContactSequenceEnrollment";
import { safeMediaSrc, sanitizeFieldKey } from "./urlSecurity";
import type { FieldSpec, Row } from "./types";

export const detailTabList = ["Overview", "Activity", "Notes", "Emails", "Calls", "History"] as const;
export type DetailTab = (typeof detailTabList)[number];

export const activityFilters = ["All", "Emails", "Calls", "Meetings", "Notes", "System"] as const;
export type ActivityFilter = (typeof activityFilters)[number];

export const activityFilterTypes: Partial<Record<ActivityFilter, string>> = {
  Emails: "Email",
  Calls: "Call",
  Meetings: "Meeting",
  Notes: "Note",
  System: "System",
};

export function RecordDetailPage({
  resource,
  fields,
  title,
}: {
  resource: string;
  fields: FieldSpec[];
  title: string;
}) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast, user } = useApp();
  const [record, setRecord] = useState<Row | null>(null);
  const recordRoute = useRef("");
  recordRoute.current = `${resource}/${id}`;
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<DetailTab>(resource === "contacts" ? "Activity" : "Overview");
  const [activities, setActivities] = useState<Row[]>([]);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("All");
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState(false);
  const [activityRetry, setActivityRetry] = useState(0);
  const [messages, setMessages] = useState<Row[]>([]);
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState(false);
  const [emailRetry, setEmailRetry] = useState(0);
  const [revisions, setRevisions] = useState<Row[]>([]);
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);

  const canEdit = user?.role === "admin" || user?.role === "member";
  const recordName = record?.name || record?.title || "Untitled";
  const showActivityFilters = resource === "contacts" || resource === "companies";
  const photoKey = resource === "companies" ? "logo" : "avatar";
  const photoField: FieldSpec = {
    key: photoKey,
    label: resource === "companies" ? "Logo" : "Photo",
    type: "photo",
  };
  const safeFields = fields.filter((field) => Boolean(sanitizeFieldKey(field.key)));
  const detailFields: FieldSpec[] =
    resource === "contracts"
      ? safeFields
      : [photoField, ...safeFields.filter((field) => field.key !== photoKey)];

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setRecord(null);
    setTab(resource === "contacts" ? "Activity" : "Overview");
    setNoteText("");
    setActivityFilter("All");
    const controller = new AbortController();
    api<Row>(`/${resource}/${id}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setRecord(result);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        toast("Record not found", "error");
        navigate(`/${resource}`, { replace: true });
      });
    return () => controller.abort();
  }, [id, resource, toast, navigate]);

  useEffect(() => {
    if (!record || (tab !== "Activity" && tab !== "Notes" && tab !== "Calls")) return;
    const params = new URLSearchParams({ recordId: record.id });
    const name = record.name || record.title || "";
    if (name && resource !== "contracts") params.set("contact", name);
    const type =
      tab === "Notes"
        ? "Note"
        : tab === "Calls"
          ? "Call"
          : showActivityFilters
            ? activityFilterTypes[activityFilter]
            : undefined;
    if (type) params.set("type", type);
    const controller = new AbortController();
    setActivities([]);
    setActivityError(false);
    setActivityLoading(true);
    api<Row[] | { data: Row[] }>(`/activities?${params}`, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        const items = Array.isArray(response) ? response : response.data;
        if (!Array.isArray(items)) throw new Error("Invalid activity response");
        setActivities(
          items.filter(
            (item) => item && typeof item === "object" && typeof item.id === "string",
          ),
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
          setActivityError(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setActivityLoading(false);
      });
    return () => controller.abort();
  }, [record, tab, activityFilter, showActivityFilters, activityRetry, resource]);

  useEffect(() => {
    setMessages([]);
    setEmailLoading(false);
    setEmailError(false);
    if (!record?.email || tab !== "Emails") return;
    const controller = new AbortController();
    setEmailLoading(true);
    setEmailError(false);
    api<Row[] | { data: Row[] }>("/messages", { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        const items = Array.isArray(response) ? response : response.data;
        if (!Array.isArray(items)) throw new Error("Invalid message response");
        setMessages(
          items.filter(
            (message) =>
              message.to === record.email &&
              (!message.channel || message.channel.toLowerCase() === "email"),
          ),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setEmailError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setEmailLoading(false);
      });
    return () => controller.abort();
  }, [record?.email, tab, emailRetry]);

  useEffect(() => {
    setRevisions([]);
    if (!record || resource !== "contacts" || tab !== "History") return;
    const controller = new AbortController();
    api<{ data: Row[] }>(`/revisions/${resource}/${record.id}`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setRevisions(result.data || []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRevisions([]);
      });
    return () => controller.abort();
  }, [record?.id, record?.updatedAt, resource, tab]);

  async function addNote() {
    if (!noteText.trim() || !record) return;
    setNoteBusy(true);
    try {
      const note = await api<Row>(
        "/activities",
        json("POST", {
          title: `Note on ${title.slice(0, -1)}`,
          type: "Note",
          recordId: record.id,
          contact: record.name || record.title || "",
          date: new Date().toISOString().slice(0, 10),
          notes: noteText,
        }),
      );
      setActivities((previous) => [note, ...previous]);
      setNoteText("");
      toast("Note added");
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setNoteBusy(false);
    }
  }

  async function deleteRecord() {
    if (!record || !confirm(`Delete ${recordName}?`)) return;
    try {
      await api(`/${resource}/${record.id}`, { method: "DELETE" });
      toast("Deleted");
      navigate(`/${resource}`, { replace: true });
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  if (loading) {
    return (
      <div className="page">
        <div className="table-loading" role="status">Loading…</div>
      </div>
    );
  }
  if (!record) return null;

  const activityIcon = (type: string) => {
    const icons: Record<string, string> = {
      Note: "edit",
      Meeting: "calendar",
      Email: "inbox",
      SMS: "inbox",
      Call: "phone",
    };
    const tones: Record<string, string> = {
      Note: "tone-purple",
      Meeting: "tone-blue",
      Email: "tone-green",
      SMS: "tone-amber",
      Call: "tone-red",
    };
    return (
      <span className={`activity-icon ${tones[type] || "tone-blue"}`}>
        <Icon name={icons[type] || "activity"} />
      </span>
    );
  };

  const propertiesPanel = (
    <div className="detail-section">
      {(resource === "contacts" || resource === "leads") && (
        <LifecycleStage
          key={`${resource}/${record.id}`}
          recordId={record.id}
          stage={record.lifecycleStage}
          disabled={!canEdit}
          onSaved={(updated) => {
            if (recordRoute.current !== `${resource}/${record.id}`) return;
            setRecord((previous) =>
              previous?.id === record.id ? { ...previous, ...updated } : previous,
            );
            setActivityRetry((value) => value + 1);
            toast("Lifecycle stage updated");
          }}
        />
      )}
      <h3>{resource === "contracts" ? "Contract summary" : "Contact information"}</h3>
      <dl className="detail-props">
        {detailFields.map((field) => {
          const key = sanitizeFieldKey(field.key);
          if (!key) return null;
          return (
            <div key={key}>
              <dt>{field.label}</dt>
              <dd>
                <InlineEditField
                  key={`${resource}/${record.id}/${key}`}
                  field={field}
                  value={record[key]}
                  disabled={!canEdit}
                  displayValue={
                    field.type === "photo"
                      ? record[key]
                        ? "Change image"
                        : "Add image"
                      : record[key] == null || record[key] === ""
                        ? undefined
                        : resource === "contracts"
                          ? contractSummaryValue(record[key], field.type, key)
                          : field.type === "number" && key === "value"
                            ? money(record[key])
                            : undefined
                  }
                  onSave={async (value) => {
                    const route = `${resource}/${record.id}`;
                    const patch =
                      field.type === "photo"
                        ? { [key]: safeMediaSrc(value) }
                        : { [key]: value };
                    const updated = await api<Row>(
                      `/${resource}/${record.id}`,
                      json("PATCH", patch),
                    );
                    if (recordRoute.current !== route) return;
                    setRecord((previous) =>
                      previous?.id === record.id
                        ? {
                            ...previous,
                            [key]: Object.prototype.hasOwnProperty.call(updated, key)
                              ? updated[key]
                              : patch[key],
                            updatedAt: updated.updatedAt ?? previous.updatedAt,
                          }
                        : previous,
                    );
                    toast(`${field.label} updated`);
                  }}
                />
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );

  const tabs =
    resource === "contracts"
      ? (["Overview", "Activity"] as const)
      : resource === "contacts"
        ? detailTabList.filter((item) => item !== "Overview")
        : detailTabList.filter((item) => item !== "History" && item !== "Calls");

  return (
    <div className="page">
      <div className="detail-header">
        <button className="btn ghost compact" onClick={() => navigate(`/${resource}`)}>
          <Icon name="arrowRight" /> Back to {title}
        </button>
        <div className="detail-header-main">
          <Avatar name={recordName} src={safeMediaSrc(record.avatar || record.logo)} size={48} />
          <div>
            <div className="lead-detail-name">
              <h1>{recordName}</h1>
              {resource === "leads" && typeof record.leadScore === "number" ? (
                <span title="AI Score — based on engagement signals">
                  <Badge
                    tone={
                      record.leadScore <= 40
                        ? "red"
                        : record.leadScore <= 70
                          ? "amber"
                          : "green"
                    }
                  >
                    {record.leadScore}
                  </Badge>
                </span>
              ) : null}
            </div>
            <p>
              {record.company || record.role || record.industry || ""}
              {record.email ? ` · ${record.email}` : ""}
            </p>
          </div>
          <div className="detail-actions">
            {resource === "contacts" && <ContactSequenceEnrollment key={record.id} contact={record} />}
            {resource === "quotes" ? <GenerateInvoiceButton key={record.id} quote={record} /> : null}
            {record.status ? (
              <Badge
                tone={
                  record.status === "Qualified" || record.status === "Won"
                    ? "green"
                    : record.status === "Lost"
                      ? "red"
                      : "blue"
                }
              >
                {record.status}
              </Badge>
            ) : null}
            <button
              className="btn ghost compact danger-link"
              disabled={resource === "contracts" && !canEdit}
              aria-label={`Delete ${recordName}`}
              onClick={deleteRecord}
            >
              <Icon name="trash" />
            </button>
          </div>
        </div>
      </div>

      <div className={resource === "contacts" ? "record-360-layout" : undefined}>
        {resource === "contacts" && (
          <aside className="record-360-sidebar" aria-label="Contact properties and related records">
            {propertiesPanel}
            <AssociatedRecords
              key={record.id}
              contactId={record.id}
              company={record.company}
              name={record.name}
              email={record.email}
            />
          </aside>
        )}
        <section className="record-360-main" aria-label="Record activity">
          <div className="detail-tabs" role="group" aria-label="Record sections">
            {tabs.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={tab === item}
                className={tab === item ? "active" : ""}
                onClick={() => setTab(item)}
              >
                {resource === "contracts" && item === "Activity" ? "Activity timeline" : item}
                {item === "Emails" && messages.length ? (
                  <span>{messages.length}</span>
                ) : item === "Activity" && tab === "Activity" && activities.length ? (
                  <span>{activities.length}</span>
                ) : item === "History" && revisions.length ? (
                  <span>{revisions.length}</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="detail-body">
            {tab === "Overview" && (
              <div className="detail-overview">
                {propertiesPanel}
                {resource === "contracts" ? <ContractDetails record={record} /> : null}
              </div>
            )}

            {(tab === "Activity" || tab === "Calls") && (
              <div className="detail-activity">
                {showActivityFilters && tab === "Activity" && (
                  <div
                    className="detail-tabs activity-filter-tabs"
                    role="group"
                    aria-label="Filter activities"
                  >
                    {activityFilters.map((filter) => (
                      <button
                        key={filter}
                        type="button"
                        aria-pressed={activityFilter === filter}
                        className={activityFilter === filter ? "active" : ""}
                        onClick={() => setActivityFilter(filter)}
                      >
                        {filter}
                      </button>
                    ))}
                  </div>
                )}
                {activityLoading ? (
                  <div className="table-loading" role="status">Loading activities…</div>
                ) : activityError ? (
                  <Empty
                    icon="activity"
                    title="Could not load activities"
                    text="Try loading this section again."
                    action={
                      <button
                        type="button"
                        className="btn secondary compact"
                        onClick={() => setActivityRetry((value) => value + 1)}
                      >
                        Retry
                      </button>
                    }
                  />
                ) : activities.length ? (
                  activities.map((activity) => (
                    <div className="activity-item" key={activity.id}>
                      {activityIcon(activity.type)}
                      <div>
                        <div className="activity-item-head">
                          <b>{activity.title || activity.type}</b>
                          <time>{activity.date || activity.createdAt || ""}</time>
                        </div>
                        <p>
                          {activity.notes || activity.type}
                          {activity.contact ? (
                            <>
                              {" "} — <strong>{activity.contact}</strong>
                            </>
                          ) : null}
                        </p>
                      </div>
                    </div>
                  ))
                ) : (
                  <Empty
                    icon="activity"
                    title={tab === "Calls" ? "No calls yet" : "No activity yet"}
                    text="Activities related to this record will appear here."
                  />
                )}
              </div>
            )}

            {tab === "Notes" && (
              <div className="detail-notes">
                <div className="note-compose">
                  <textarea
                    aria-label="Add a note"
                    value={noteText}
                    onChange={(event) => setNoteText(event.target.value)}
                    placeholder="Write a note…"
                    rows={3}
                  />
                  <button
                    className="btn primary compact"
                    disabled={noteBusy || !noteText.trim()}
                    onClick={addNote}
                  >
                    {noteBusy ? "Saving…" : "Add note"}
                  </button>
                </div>
                {!activityLoading &&
                  activities
                    .filter((activity) => activity.type === "Note")
                    .map((note) => (
                      <div className="note-card" key={note.id}>
                        <div className="note-card-head">
                          <b>Note</b>
                          <time>{note.date || note.createdAt || ""}</time>
                        </div>
                        <p>{note.notes || note.title}</p>
                      </div>
                    ))}
                {activityLoading ? (
                  <div className="table-loading" role="status">Loading notes…</div>
                ) : activityError ? (
                  <Empty icon="edit" title="Could not load notes" text="Try reopening this tab." />
                ) : !activities.filter((activity) => activity.type === "Note").length && !noteText ? (
                  <Empty icon="edit" title="No notes yet" text="Add the first note for this record." />
                ) : null}
              </div>
            )}

            {tab === "Emails" && (
              <div className="detail-emails">
                {emailLoading ? (
                  <div className="table-loading" role="status">Loading emails…</div>
                ) : emailError ? (
                  <div role="alert">
                    Could not load emails.{" "}
                    <button
                      type="button"
                      className="btn secondary compact"
                      onClick={() => setEmailRetry((value) => value + 1)}
                    >
                      Retry
                    </button>
                  </div>
                ) : messages.length ? (
                  messages.map((message) => (
                    <div className="email-item" key={message.id}>
                      <div className="email-item-head">
                        <Badge
                          tone={
                            message.status === "Sent"
                              ? "green"
                              : message.status === "Failed"
                                ? "red"
                                : "blue"
                          }
                        >
                          {message.channel || "Email"}
                        </Badge>
                        <b>{message.subject || "(no subject)"}</b>
                        <time>{message.createdAt || ""}</time>
                      </div>
                      <p>{message.body || ""}</p>
                      <span className="email-meta">To: {message.to}</span>
                    </div>
                  ))
                ) : (
                  <Empty
                    icon="inbox"
                    title="No emails yet"
                    text="Emails sent to this contact will appear here."
                  />
                )}
              </div>
            )}

            {tab === "History" && resource === "contacts" && (
              <div className="detail-activity">
                {revisions.length ? (
                  revisions.map((revision) => (
                    <div className="activity-item" key={revision.id}>
                      <span className="activity-icon tone-blue">
                        <Icon name="edit" />
                      </span>
                      <div>
                        <div className="activity-item-head">
                          <b>{revision.actor || "System"}</b>
                          <time>{revision.createdAt || ""}</time>
                        </div>
                        {(revision.changes as Row[] | undefined)?.map((change: Row) => (
                          <p key={`${revision.id}-${change.field}`}>
                            <strong>{change.field}</strong>: {String(change.from ?? "—")} →{" "}
                            {String(change.to ?? "—")}
                          </p>
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <Empty
                    icon="edit"
                    title="No history yet"
                    text="Changes to this contact will appear here."
                  />
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
