import { useState } from "react";
import { Icon } from "../../components/Icon";
import { Badge, Empty, Modal, PageHeader } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import { api, json } from "../../lib/api";
import { useResource } from "../../lib/useResource";

type Row = {
  id: string;
  [key: string]: any;
};

export function RecordingsPage() {
  const { items, load, remove } = useResource<Row>("recordings");
  const { toast } = useApp();
  const [selected, setSelected] = useState<Row | null>(null);
  const [transcribing, setTranscribing] = useState(false);

  async function summarize(item: Row) {
    try {
      const result = await api<Row>(
        `/recordings/${item.id}/summarize`,
        json("POST"),
      );
      setSelected(result);
      toast("Summary updated");
      load();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  async function transcribe(item: Row) {
    setTranscribing(true);

    try {
      const result = await api<Row>(
        `/recordings/${item.id}/transcribe`,
        json("POST"),
      );

      setSelected(result);
      toast("Transcription ready");
      await load();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setTranscribing(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Recordings"
        description="Recording records are created automatically from completed calls."
      />

      {items.length ? (
        <section className="surface recordings-list">
          {items.map((item) => (
            <article className="recording-row" key={item.id}>
              <button
                className="play-btn"
                disabled={!item.fileUrl}
                onClick={() => setSelected(item)}
                title={
                  item.fileUrl
                    ? "Open recording"
                    : "Audio will be available when a provider supplies media"
                }
              >
                <Icon name={item.fileUrl ? "play" : "recording"} />
              </button>

              <div className="recording-person">
                <button
                  className="recording-title"
                  onClick={() => setSelected(item)}
                >
                  {item.title || item.originalName || "Call recording"}
                </button>

                <small>
                  {item.contact || item.phone || "No linked contact"} ·{" "}
                  {new Date(item.createdAt).toLocaleString()}
                </small>
              </div>

              <Badge tone={item.fileUrl ? "green" : "amber"}>
                {item.mediaStatus ||
                  (item.fileUrl ? "Audio ready" : "Awaiting audio")}
              </Badge>

              <div className="row-actions">
                <button
                  className="btn secondary compact"
                  onClick={() => setSelected(item)}
                >
                  Open
                </button>

                <button
                  className="icon-btn tiny danger-link"
                  onClick={() =>
                    confirm("Delete this recording record?") && remove(item.id)
                  }
                  title="Delete"
                >
                  <Icon name="trash" />
                </button>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <Empty
          icon="recording"
          title="No recordings"
          text="Complete a call and Tunaxa will create its recording record automatically when call recording is enabled."
        />
      )}

      {selected ? (
        <Modal
          title={selected.title || "Recording"}
          onClose={() => setSelected(null)}
          footer={
            <>
              <button
                className="btn secondary"
                onClick={() => setSelected(null)}
              >
                Close
              </button>

              <button
                className="btn secondary"
                disabled={!selected.fileUrl || transcribing}
                onClick={() => transcribe(selected)}
              >
                <Icon name="ai" />
                {transcribing ? "Processing transcript..." : "Transcribe"}
              </button>

              <button
                className="btn primary"
                disabled={!selected.transcript}
                onClick={() => summarize(selected)}
              >
                <Icon name="spark" /> Generate summary
              </button>
            </>
          }
        >
          {selected.fileUrl ? (
            <audio
              controls
              src={selected.fileUrl}
              className="audio-player"
            />
          ) : (
            <div className="media-pending">
              <Icon name="recording" />
              <div>
                <b>Audio is not available yet</b>
                <p>
                  This call record was created automatically. A connected
                  telephony provider can attach the actual call media here.
                </p>
              </div>
            </div>
          )}

          <div className="recording-detail">
            <h3>
              Summary{" "}
              {selected.summaryAi ? <Badge tone="green">AI</Badge> : null}
            </h3>

            <p>{selected.summary || "No summary yet."}</p>

            <h3>Transcript</h3>

            <div
              className="transcript-text"
              style={{
                maxHeight: "280px",
                overflowY: "auto",
                whiteSpace: "pre-wrap",
                padding: "12px",
              }}
            >
              {transcribing ? (
                <span>Processing transcript...</span>
              ) : selected.transcript ? (
                selected.transcript
              ) : (
                <span>No transcript is available yet.</span>
              )}
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}