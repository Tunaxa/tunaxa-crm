import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Badge } from "../../components/ui";
import { dateLabel, dateTime } from "../communications/inbox/inboxModel";
import {
  parseContactEmailAnalytics,
  type ContactEmailAnalytics as Analytics,
} from "./contactEmailAnalyticsModel";
import "./contactEmailAnalytics.css";

type Props = {
  contactId?: string;
};

export function ContactEmailAnalytics({ contactId }: Props) {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!contactId) {
      setAnalytics(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    api<unknown>(`/contacts/${encodeURIComponent(contactId)}/email-analytics`, {
      signal: controller.signal,
    })
      .then((payload) => {
        if (!controller.signal.aborted) {
          setAnalytics(parseContactEmailAnalytics(payload));
        }
      })
      .catch((reason: unknown) => {
        if (
          !controller.signal.aborted &&
          (reason as { name?: string })?.name !== "AbortError"
        ) {
          setError(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [contactId, retry]);

  useEffect(() => {
    const refresh = (event: Event) => {
      const changed = (event as CustomEvent<{ resource?: string }>).detail?.resource;
      if (!changed || changed === "messages" || changed === "contacts") {
        setRetry((value) => value + 1);
      }
    };
    window.addEventListener("tunaxa:resource-changed", refresh);
    return () => window.removeEventListener("tunaxa:resource-changed", refresh);
  }, []);

  if (!contactId) return null;

  return (
    <ContactEmailAnalyticsView
      analytics={analytics}
      loading={loading}
      error={error}
      onRetry={() => setRetry((value) => value + 1)}
    />
  );
}

export function ContactEmailAnalyticsView({
  analytics,
  loading,
  error,
  onRetry,
}: {
  analytics: Analytics | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  if (loading && !analytics) {
    return (
      <section
        className="contact-email-analytics"
        aria-label="Contact email analytics"
        role="status"
        aria-live="polite"
      >
        Loading email analytics…
      </section>
    );
  }

  if (error) {
    return (
      <section
        className="contact-email-analytics"
        aria-label="Contact email analytics"
        role="alert"
      >
        Could not load email analytics.
        <button
          type="button"
          className="contact-email-analytics-retry"
          onClick={onRetry}
        >
          Retry
        </button>
      </section>
    );
  }

  if (!analytics || analytics.sentEmails === 0) {
    return (
      <section
        className="contact-email-analytics"
        aria-label="Contact email analytics"
        role="status"
      >
        No sent emails tracked for this contact.
      </section>
    );
  }

  const tone =
    analytics.openRate >= 50
      ? "green"
      : analytics.openRate > 0
        ? "amber"
        : "neutral";

  return (
    <section className="contact-email-analytics" aria-label="Contact email analytics">
      <header className="contact-email-analytics-head">
        <h3>Email engagement</h3>
        <span
          className="contact-email-analytics-status"
          data-tone={tone}
          aria-label={`Open rate ${analytics.openRate}%`}
        >
          <Badge tone={tone}>{`Open rate ${analytics.openRate}%`}</Badge>
        </span>
      </header>
      <span className="contact-email-analytics-id">{analytics.contactId}</span>
      <dl className="contact-email-analytics-grid">
        <div>
          <dt>Sent emails</dt>
          <dd>{analytics.sentEmails}</dd>
        </div>
        <div>
          <dt>Opened emails</dt>
          <dd>{analytics.openedEmails}</dd>
        </div>
        <div>
          <dt>Total opens</dt>
          <dd>{analytics.totalOpens}</dd>
        </div>
        <div>
          <dt>Clicks</dt>
          <dd>{analytics.clickCount}</dd>
        </div>
      </dl>
      <p className="contact-email-analytics-last">
        <span>Last opened</span>{" "}
        <time
          dateTime={dateTime(analytics.lastOpenedAt)}
          aria-label={`Last opened ${dateLabel(analytics.lastOpenedAt)}`}
        >
          {analytics.lastOpenedAt
            ? dateLabel(analytics.lastOpenedAt)
            : "Not opened yet"}
        </time>
      </p>
    </section>
  );
}
