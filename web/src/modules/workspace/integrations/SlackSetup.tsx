import { useRef, useState } from "react";
import { Drawer } from "../../../components/ui";
import { slackPayload, type IntegrationChannel } from "./integrationModel";

export function SlackSetup({ current, allowed, available, onClose, onSave }: {
  current: IntegrationChannel; allowed: boolean; available: boolean; onClose: () => void; onSave: (url: string) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef(false);
  const close = () => { if (!operation.current) { setUrl(""); onClose(); } };
  async function save() {
    if (operation.current || !allowed || !available) return;
    setError("");
    try { slackPayload(url); } catch (failure) { setError((failure as Error).message); return; }
    operation.current = true; setBusy(true);
    try { await onSave(url); setUrl(""); onClose(); }
    catch (failure) { setError((failure as Error).message); }
    finally { operation.current = false; setBusy(false); }
  }
  return <Drawer title={current.configured ? "Replace Slack webhook" : "Connect Slack"} subtitle="Save an incoming webhook for your workspace’s deal-won updates." onClose={close} width={620}
    footer={<><button type="button" className="btn secondary" disabled={busy} onClick={close}>Cancel</button><button type="button" className="btn primary" disabled={busy || !allowed || !available || !url.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save Slack configuration"}</button></>}>
    <div className="slack-setup">
      {!allowed && <p role="alert">Only workspace administrators can configure integrations.</p>}
      {!available && <p role="alert">Refresh integration configuration before saving.</p>}
      {error && <p role="alert">{error}</p>}
      <ol><li>Open your Slack app’s settings and enable Incoming Webhooks.</li><li>Add a webhook to your workspace and choose the channel.</li><li>Copy the generated webhook URL and paste it below.</li></ol>
      <a href="https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks" target="_blank" rel="noreferrer">Slack incoming webhook setup guide</a>
      {current.configured && <p>Current webhook: <span className="integration-masked-url">{current.webhookUrlMasked}</span></p>}
      <label className="field"><span>{current.configured ? "New Slack incoming webhook URL *" : "Slack incoming webhook URL *"}</span><input type="password" name="slackWebhookUrl" autoComplete="off" spellCheck={false} value={url} disabled={busy || !allowed || !available} onChange={event => setUrl(event.target.value)} placeholder="Paste the webhook URL from Slack" aria-describedby="slack-webhook-help" /></label>
      <p id="slack-webhook-help">The URL contains your webhook secret. Paste the full URL here; the saved configuration displays only a masked version.</p>
      <p>Saving configures the webhook. Delivery is not tested by this form.</p>
    </div>
  </Drawer>;
}
