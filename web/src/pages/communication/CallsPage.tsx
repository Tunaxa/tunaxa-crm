
import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { Empty, PageHeader } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import { api, json } from "../../lib/api";
import { useResource } from "../../lib/useResource";

type Row = {
  id: string;
  [key: string]: any;
};

export function CallsPage() {
  const { items, load, create, remove } = useResource<Row>("calls");
  const { toast } = useApp();
  const [number, setNumber] = useState("");
  const [active, setActive] = useState<Row | null>(null);
  const [started, setStarted] = useState<number | null>(null);
  const [ending, setEnding] = useState(false);
  const [twilio, setTwilio] = useState(false);

  const keypad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

  useEffect(() => {
    api<{ configured: boolean }>("/twilio/status")
      .then((result) => setTwilio(result.configured))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (active) return;
    const existing = items.find((call) => call.status === "Connected");
    if (!existing) return;

    setActive(existing);
    setNumber(existing.phone || "");
    setStarted(
      existing.startedAt ? new Date(existing.startedAt).getTime() : Date.now(),
    );
  }, [items, active]);

  async function startCall() {
    if (!number.trim()) return toast("Enter a phone number", "error");

    try {
      let call: Row;

      if (twilio) {
        call = await api<Row>(
          "/calls/dial",
          json("POST", { phone: number.trim() }),
        );
        toast("Call placed via Twilio");
      } else {
        call = await create({
          phone: number.trim(),
          direction: "Outbound",
          status: "Connected",
          startedAt: new Date().toISOString(),
          duration: 0,
        });
        toast("Call session started");
      }

      setActive(call);
      setStarted(Date.now());
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  async function endCall() {
    if (!active || ending) return;
    setEnding(true);

    try {
      const duration = started
        ? Math.max(1, Math.floor((Date.now() - started) / 1000))
        : 0;

      const result = await api<{
        call: Row;
        recording?: Row;
        activity?: Row;
      }>(
        `/calls/${active.id}/complete`,
        json("POST", { duration, endedAt: new Date().toISOString() }),
      );

      await load();
      setActive(null);
      setStarted(null);
      setNumber("");

      toast(
        result.recording
          ? "Call completed and recording record created"
          : "Call completed",
      );
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setEnding(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Telephony"
        description="Start calls from the dialer. With Twilio configured, real calls are placed; otherwise Tunaxa logs the local call session."
      />

      <div className="calls-grid">
        <section className="surface dialer-card">
          <div className="dialer-head">
            <span className={`phone-status ${active ? "calling" : ""}`}>
              <i />
              {active ? "Connected" : "Ready"}
            </span>

            <button
              className="icon-btn"
              disabled={Boolean(active)}
              onClick={() => setNumber("")}
              title="Clear"
            >
              <Icon name="close" />
            </button>
          </div>

          <input
            className="dial-input"
            aria-label="Phone number"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="Enter a number"
            disabled={Boolean(active)}
          />

          <div className="keypad">
            {keypad.map((key) => (
              <button
                key={key}
                disabled={Boolean(active)}
                onClick={() => setNumber((value) => value + key)}
              >
                {key}
              </button>
            ))}
          </div>

          {active ? (
            <button
              className="call-button danger"
              disabled={ending}
              onClick={endCall}
            >
              <Icon name="phone" /> {ending ? "Ending…" : "End call"}
            </button>
          ) : (
            <button className="call-button" onClick={startCall}>
              <Icon name="phone" /> {twilio ? "Call via Twilio" : "Start call"}
            </button>
          )}

          <div className="call-note">
            <Icon name="warning" />
            <span>
              {twilio
                ? "Twilio is configured. Calls are placed through your provider and require a public webhook URL in Settings."
                : "Actual phone connectivity requires a configured telephony provider. Tunaxa still logs the local call session and related CRM activity."}
            </span>
          </div>
        </section>

        <section className="surface call-history">
          <div className="section-head">
            <div>
              <h2>Call history</h2>
              <p>
                {items.length
                  ? `${items.length} calls logged`
                  : "Calls will appear here automatically"}
              </p>
            </div>
          </div>

          {items.length ? (
            items.map((call) => (
              <article className="call-row" key={call.id}>
                <span
                  className={`call-direction ${call.direction === "Inbound" ? "received" : ""}`}
                >
                  <Icon name="phone" />
                </span>

                <div>
                  <b>{call.contact || call.phone || "Unknown number"}</b>
                  <small>
                    {call.direction || "Outbound"} · {call.status || "Logged"} ·{" "}
                    {call.duration || 0}s
                    {call.provider ? ` · ${call.provider}` : ""}
                  </small>
                </div>

                <time>{new Date(call.createdAt).toLocaleString()}</time>

                <button
                  className="icon-btn tiny danger-link"
                  onClick={() =>
                    confirm("Delete this call log?") && remove(call.id)
                  }
                  title="Delete call"
                >
                  <Icon name="trash" />
                </button>
              </article>
            ))
          ) : (
            <Empty
              icon="phone"
              title="No calls"
              text="Use the dialer to make your first call. Call logs are created automatically."
            />
          )}
        </section>
      </div>
    </div>
  );
}