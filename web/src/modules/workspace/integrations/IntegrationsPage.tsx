import { useId, useState } from "react";
import { Badge, Empty, PageHeader } from "../../../components/ui";
import { Icon } from "../../../components/Icon";
import { useApp } from "../../../context/AppContext";
import { canManageIntegrations, integrationNames, type IntegrationKey } from "./integrationModel";
import { useIntegrations } from "./useIntegrations";
import { SlackSetup } from "./SlackSetup";
import "./integrations.css";

const views = ["Connected", "Browse"] as const;
type View = typeof views[number];

export function IntegrationsPage() {
  const state = useIntegrations();
  const { user, toast } = useApp();
  const [view, setView] = useState<View>("Connected");
  const [setup, setSetup] = useState(false);
  const id = useId();
  const allowed = canManageIntegrations(user?.role);
  const available = Boolean(state.config && !state.loading && !state.error && !state.saving);
  const connected = state.config ? (Object.keys(integrationNames) as IntegrationKey[]).filter(key => state.config![key].configured) : [];

  return <div className="page integrations-page">
    <PageHeader title="Integrations" description="Connect your workspace to the tools your team uses." />
    <div className="integration-tabs" role="tablist" aria-label="Integration views">
      {views.map((tab, index) => <button type="button" role="tab" key={tab} id={`${id}-${tab}`} aria-selected={view === tab} aria-controls={`${id}-panel`} tabIndex={view === tab ? 0 : -1}
        className={view === tab ? "active" : ""} onClick={() => setView(tab)} onKeyDown={event => {
          let next: number | undefined;
          if (event.key === "ArrowRight") next = (index + 1) % views.length;
          if (event.key === "ArrowLeft") next = (index + views.length - 1) % views.length;
          if (event.key === "Home") next = 0;
          if (event.key === "End") next = views.length - 1;
          if (next !== undefined) { event.preventDefault(); setView(views[next]); document.getElementById(`${id}-${views[next]}`)?.focus(); }
        }}>{tab}</button>)}
    </div>
    {state.loading && <p role="status">{state.config ? "Refreshing integrations…" : "Loading integrations…"}</p>}
    {state.error && <div className="integration-notice" role="alert"><p>{state.error}</p><button type="button" className="btn secondary compact" disabled={state.loading || state.saving} onClick={() => void state.load()}>Retry integrations</button>{state.config && <p>Showing the last loaded configuration.</p>}</div>}
    <section id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${view}`} tabIndex={0}>
      {view === "Connected" ? !state.config ? !state.loading && !state.error && <Empty icon="webhook" title="Configuration unavailable" text="Refresh to view your workspace’s integrations." /> : connected.length ? <div className="integration-cards">
        {connected.map(key => <article className="surface integration-card" key={key}>
          <div className="integration-card-heading"><span className="integration-icon"><Icon name="webhook" /></span><h2>{integrationNames[key]}</h2><Badge tone="green">Configured</Badge></div>
          <p>{key === "slack" ? "Deal-won updates for your Slack channel." : "Outbound deal-won updates for your connected Zapier workflow."}</p>
          <p className="integration-masked-url">{state.config![key].webhookUrlMasked}</p>
          <small>Saved configuration; delivery has not been verified here.</small>
          {key === "slack" && allowed && <footer><button type="button" className="btn secondary" disabled={!available} onClick={() => setSetup(true)}>Replace webhook</button></footer>}
        </article>)}
      </div> : <Empty icon="webhook" title="No connected integrations" text="Browse integrations to configure Slack for your workspace." action={<button type="button" className="btn secondary" onClick={() => setView("Browse")}>Browse integrations</button>} /> : <div className="integration-cards">
        <article className="surface integration-card"><div className="integration-card-heading"><span className="integration-icon"><Icon name="webhook" /></span><h2>Slack</h2><Badge tone={state.config?.slack.configured ? "green" : "neutral"}>{state.config ? state.config.slack.configured ? "Configured" : "Not configured" : "Status unavailable"}</Badge></div>
          <p>Send deal-won updates to a Slack channel using an incoming webhook.</p>
          {allowed ? <button type="button" className="btn primary" disabled={!available} onClick={() => setSetup(true)}>{state.config?.slack.configured ? "Replace webhook" : "Connect Slack"}</button> : <p>Ask a workspace administrator to configure Slack.</p>}
        </article>
      </div>}
    </section>
    {setup && state.config && <SlackSetup current={state.config.slack} allowed={allowed} available={Boolean(state.config && !state.loading && !state.error)} onClose={() => setSetup(false)} onSave={async url => {
      if (!allowed) throw new Error("Only workspace administrators can configure integrations.");
      if (!available) throw new Error("Refresh integration configuration before saving.");
      await state.saveSlack(url); toast("Slack configuration saved"); setView("Connected");
    }} />}
  </div>;
}
