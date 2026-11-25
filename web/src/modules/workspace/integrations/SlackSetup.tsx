import { useId, useRef, useState } from "react";
import { Drawer } from "../../../components/ui";
import {
  slackPayload,
  type IntegrationChannel,
  type SlackTestResult,
} from "./integrationModel";

export function SlackSetup({
  current,
  allowed,
  available,
  saving,
  testing,
  onClose,
  onSave,
  onDisconnect,
  onTest,
}: {
  current: IntegrationChannel;
  allowed: boolean;
  available: boolean;
  saving: boolean;
  testing: boolean;
  onClose: () => void;
  onSave: (url: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onTest: () => Promise<SlackTestResult>;
}) {
  const labelId = useId();
  const [url, setUrl] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<SlackTestResult | null>(null);
  const operation = useRef(false);
  const busy = localBusy || saving || testing;

  const close = () => {
    if (operation.current || busy) return;
    setUrl("");
    onClose();
  };

  async function save() {
    if (operation.current || busy || !allowed || !available) return;
    setError("");
    setNotice(null);
    try {
      slackPayload(url);
    } catch (failure) {
      setError((failure as Error).message);
      return;
    }
    operation.current = true;
    setLocalBusy(true);
    try {
      await onSave(url);
      setUrl("");
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      operation.current = false;
      setLocalBusy(false);
    }
  }

  async function disconnect() {
    if (operation.current || busy || !allowed || !available || !current.configured) return;
    operation.current = true;
    setLocalBusy(true);
    setError("");
    setNotice(null);
    try {
      await onDisconnect();
      setUrl("");
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      operation.current = false;
      setLocalBusy(false);
    }
  }

  async function test() {
    if (operation.current || busy || !allowed || !available || !current.configured) return;
    operation.current = true;
    setLocalBusy(true);
    setError("");
    setNotice(null);
    try {
      setNotice(await onTest());
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      operation.current = false;
      setLocalBusy(false);
    }
  }

  return (
    <Drawer
      title={current.configured ? "Configure Slack" : "Connect Slack"}
      subtitle="Save an incoming webhook for your workspace’s deal-won updates."
      labelId={labelId}
      busy={busy}
      onClose={close}
      width={620}
      footer={
        <>
          <button type="button" className="btn secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          {current.configured ? (
            <>
              <button
                type="button"
                className="btn secondary"
                disabled={busy || !allowed || !current.configured}
                onClick={() => void test()}
              >
                Test Connection
              </button>
              <button
                type="button"
                className="btn secondary"
                disabled={busy || !allowed || !current.configured}
                onClick={() => void disconnect()}
              >
                Disconnect
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="btn primary"
            disabled={busy || !allowed || !available || !url.trim()}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save Slack configuration"}
          </button>
        </>
      }
    >
      <div className="slack-setup">
        {!allowed && <p role="alert">Only workspace administrators can configure integrations.</p>}
        {!available && <p role="alert">Refresh integration configuration before saving.</p>}
        {error && <p role="alert">{error}</p>}
        {testing && <p role="status">Testing Slack connection…</p>}
        {notice?.success && (
          <p className="integration-status" role="status">
            Slack connection check passed.
          </p>
        )}
        <ol>
          <li>Open your Slack app’s settings and enable Incoming Webhooks.</li>
          <li>Add a webhook to your workspace and choose the channel.</li>
          <li>Copy the generated webhook URL and paste it below.</li>
        </ol>
        <a
          href="https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks"
          target="_blank"
          rel="noreferrer"
        >
          Slack incoming webhook setup guide
        </a>
        {current.configured && (
          <p>
            Current webhook: <span className="integration-masked-url">{current.webhookUrlMasked}</span>
          </p>
        )}
        <label className="field">
          <span>{current.configured ? "New Slack incoming webhook URL *" : "Slack incoming webhook URL *"}</span>
          <input
            type="password"
            name="slackWebhookUrl"
            autoComplete="off"
            spellCheck={false}
            value={url}
            disabled={busy || !allowed || !available}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="Paste the webhook URL from Slack"
            aria-describedby="slack-webhook-help"
          />
        </label>
        <p id="slack-webhook-help">
          The URL contains your webhook secret. Paste the full URL here; the saved configuration displays
          only a masked version.
        </p>
      </div>
    </Drawer>
  );
}
