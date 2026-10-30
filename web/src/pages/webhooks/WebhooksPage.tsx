import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "../../context/AppContext";
import { Badge, Empty, Modal, PageHeader } from "../../components/ui";
import { canManageWebhooks, webhookPayload, type WebhookEndpoint } from "./webhookModel";
import { useWebhookEndpoints } from "./useWebhookEndpoints";
import "./webhooks.css";

export function EndpointCard({ endpoint, editable, disabled, onStatus }: { endpoint: WebhookEndpoint; editable: boolean; disabled: boolean; onStatus: () => void }) {
  return <article className="surface webhook-endpoint-card">
    <div className="webhook-endpoint-heading"><h2>{endpoint.url}</h2><Badge tone={endpoint.is_active ? "green" : "amber"}>{endpoint.is_active ? "Active" : "Paused"}</Badge></div>
    <h3>Subscribed events</h3><ul>{endpoint.events.map((event, index) => <li key={`${event}-${index}`}>{event}</li>)}</ul>
    {editable && <button type="button" className="btn secondary compact" disabled={disabled} onClick={onStatus}>{endpoint.is_active ? "Pause endpoint" : "Activate endpoint"}</button>}
    <details><summary>Signing secret and recent deliveries</summary>
      <p>The signing secret is shown once when an endpoint is created. Existing secrets cannot currently be retrieved.</p>
      <button type="button" className="btn secondary compact" disabled title="Secret rotation is not available yet">Rotate Secret</button>
      <p>Per-endpoint delivery history is not available yet.</p>
      <button type="button" className="btn secondary compact" disabled title="Delivery history and resend support are not available yet">Resend Failed</button>
    </details>
  </article>;
}
function CreateEndpoint({ onClose, onCreate }: { onClose: () => void; onCreate: (payload: ReturnType<typeof webhookPayload>) => Promise<{ secret: string | null }> }) {
  const [url, setUrl] = useState(""), [events, setEvents] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false), [secret, setSecret] = useState<string | null>(null), [copied, setCopied] = useState(false), [revealed, setRevealed] = useState(false);
  const running = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function close() {
    if (running.current) return;
    if (secret && !copied && !confirm("Close without copying the signing secret? It will not be shown again.")) return;
    onClose();
  }
  async function submit() {
    if (running.current || created) return;
    setError(""); let payload: ReturnType<typeof webhookPayload>;
    try { payload = webhookPayload(url, events); } catch (failure) { setError((failure as Error).message); return; }
    running.current = true; setBusy(true);
    try { const result = await onCreate(payload); if (mounted.current) { setCreated(true); setSecret(result.secret); } }
    catch (failure) { if (mounted.current) setError((failure as Error).message); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  async function copySecret() {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret); if (mounted.current) { setCopied(true); setError(""); } }
    catch { if (mounted.current) setError("Could not copy the secret. Reveal it and copy it manually."); }
  }
  return <Modal title={created ? "Endpoint created" : "New outgoing webhook"} onClose={close}>
    {error && <p role="alert">{error}</p>}
    {created ? <>
      <p role="status">The endpoint was created.</p>
      {secret ? <><label className="field"><span>HMAC signing secret — save it now</span><input type={revealed ? "text" : "password"} value={secret} readOnly autoComplete="off" spellCheck={false} /></label>
        <div className="webhook-actions"><button type="button" className="btn secondary compact" onClick={() => setRevealed(value => !value)}>{revealed ? "Hide secret" : "Reveal secret"}</button><button type="button" className="btn secondary compact" onClick={() => void copySecret()}>{copied ? "Secret copied" : "Copy secret"}</button></div>
        <p>This secret is only available in this window. Store it with the service receiving your webhook.</p></> : <p role="alert">The endpoint was created, but its signing secret was not returned. Do not create a duplicate; contact your administrator.</p>}
      <button type="button" className="btn primary" onClick={close}>Done</button>
    </> : <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label className="field"><span>Endpoint URL *</span><input type="url" required value={url} disabled={busy} onChange={event => setUrl(event.target.value)} placeholder="https://your-service.example/webhook" /></label>
      <label className="field"><span>Subscribed events *</span><textarea required value={events} disabled={busy} onChange={event => setEvents(event.target.value)} placeholder="Enter event names separated by commas or new lines" /></label>
      <button type="submit" className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create endpoint"}</button>
    </form>}
  </Modal>;
}
function OutgoingWebhooks() {
  const { user, toast } = useApp(), state = useWebhookEndpoints();
  const [creating, setCreating] = useState(false), allowed = canManageWebhooks(user?.role), available = !state.loading && !state.writing && !state.error;
  async function toggle(endpoint: WebhookEndpoint) {
    if (!allowed || !available) return;
    try { await state.setActive(endpoint); toast(endpoint.is_active ? "Endpoint paused" : "Endpoint activated"); }
    catch (failure) { toast((failure as Error).message, "error"); }
  }
  return <div className="page">
    <PageHeader title="Outgoing webhooks" description="Send subscribed events to your external services.">
      <button type="button" className="btn secondary" disabled={state.loading || state.writing} onClick={() => void state.load()}>Refresh</button>
      {allowed && <button type="button" className="btn primary" disabled={!available} onClick={() => setCreating(true)}>Add endpoint</button>}
    </PageHeader>
    {state.loading && <p role="status">Loading webhook endpoints…</p>}
    {state.error && <div role="alert"><p>{state.error}</p><button type="button" className="btn secondary compact" disabled={state.loading || state.writing} onClick={() => void state.load()}>Retry endpoints</button></div>}
    {!allowed && <p>You have read-only webhook access.</p>}
    <div className="webhook-endpoints">{state.items.map(endpoint => <EndpointCard key={endpoint.id} endpoint={endpoint} editable={allowed} disabled={!available} onStatus={() => void toggle(endpoint)} />)}</div>
    {!state.loading && !state.error && !state.items.length && <Empty icon="webhook" title="No outgoing endpoints" text="Create an endpoint to subscribe an external service to events." />}
    {creating && allowed && <CreateEndpoint onClose={() => setCreating(false)} onCreate={payload => state.create(payload)} />}
  </div>;
}
export function WebhooksPage({ inbound }: { inbound: ReactNode }) {
  const [tab, setTab] = useState("outgoing"); const { user } = useApp();
  return <><nav className="webhook-tabs" aria-label="Webhook direction">{["outgoing", "inbound"].map(value => <button type="button" className={`btn ${tab === value ? "primary" : "secondary"}`} key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{value === "outgoing" ? "Outgoing endpoints" : "Inbound triggers"}</button>)}</nav>
    {tab === "outgoing" ? <OutgoingWebhooks key={user?.id || "signed-out"} /> : inbound}
  </>;
}
