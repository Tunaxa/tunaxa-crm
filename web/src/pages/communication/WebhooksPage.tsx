import { useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { Badge, Drawer, Toggle } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import { useResource } from "../../lib/useResource";

type Row = {
  id: string;
  [key: string]: any;
};

type WebhooksPageProps = {
  SimpleCards: ComponentType<{
    title: string;
    description: string;
    icon: string;
    items: Row[];
    onAdd: () => void;
    onEdit: (row: Row) => void;
    onDelete: (id: string) => void;
    render: (row: Row) => ReactNode;
    modal?: ReactNode;
  }>;
};

export function WebhooksPage({
  SimpleCards,
}: WebhooksPageProps) {
  const { toast } = useApp();

  const { items, create, update, remove } =
    useResource<Row>("webhookEndpoints");

  const [edit, setEdit] = useState<Row | null | undefined>(
    undefined
  );

  return (
    <SimpleCards
      title="Webhooks"
      description="Inbound webhook endpoints that trigger workflows."
      icon="webhook"
      items={items}
      onAdd={() => setEdit(null)}
      onEdit={setEdit}
      onDelete={remove}
      render={(item) => (
        <>
          <div className="deal-top">
            <Badge tone={item.enabled ? "green" : "neutral"}>
              {item.enabled ? "Active" : "Disabled"}
            </Badge>

            <Toggle
              label={`${item.enabled ? "Disable" : "Enable"} ${
                item.name || "webhook endpoint"
              }`}
              value={Boolean(item.enabled)}
              onChange={(enabled) =>
                update(item.id, { enabled })
              }
            />
          </div>

          <h3>{item.name || "Untitled endpoint"}</h3>

          <p>
            {item.description || "No description"}
          </p>

          <small>
            {item.requestCount || 0} requests ·{" "}
            {item.lastReceivedAt
              ? new Date(
                  item.lastReceivedAt
                ).toLocaleString()
              : "No deliveries yet"}
          </small>

          {item.url ? (
            <button
              className="btn ghost compact"
              onClick={() =>
                navigator.clipboard
                  .writeText(item.url)
                  .then(() =>
                    toast("Webhook URL copied")
                  )
              }
            >
              <Icon name="copy" /> Copy URL
            </button>
          ) : null}
        </>
      )}
      modal={
        edit !== undefined ? (
          <WebhookEditor
            initial={edit || null}
            onClose={() => setEdit(undefined)}
            onSave={async (data) => {
              if (edit) {
                await update(edit.id, data);
              } else {
                await create(data);
              }

              setEdit(undefined);
            }}
          />
        ) : null
      }
    />
  );
}

function WebhookEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: Row | null;
  onClose: () => void;
  onSave: (
    data: Record<string, any>
  ) => Promise<void>;
}) {
  const { toast } = useApp();

  const [name, setName] = useState(
    initial?.name || ""
  );

  const [description, setDescription] =
    useState(initial?.description || "");

  const [enabled, setEnabled] = useState(
    initial?.enabled ?? true
  );

  const [busy, setBusy] = useState(false);

  async function save() {
    if (!String(name).trim()) {
      return toast(
        "Endpoint name is required",
        "error"
      );
    }

    setBusy(true);

    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        enabled,
      });
    } catch (error) {
      toast(
        (error as Error).message,
        "error"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={
        initial?.id
          ? "Edit webhook"
          : "New webhook"
      }
      subtitle="A URL you can POST JSON payloads to in order to trigger workflows."
      onClose={onClose}
      footer={
        <>
          <button
            className="btn secondary"
            onClick={onClose}
          >
            Cancel
          </button>

          <button
            className="btn primary"
            disabled={busy}
            onClick={save}
          >
            {busy
              ? "Saving…"
              : initial?.id
              ? "Save webhook"
              : "Create webhook"}
          </button>
        </>
      }
    >
      <div className="drawer-form">
        <label className="field">
          <span>Endpoint name *</span>

          <input
            autoFocus
            value={name}
            onChange={(e) =>
              setName(e.target.value)
            }
            placeholder="e.g. Product signup webhook"
          />
        </label>

        <label className="field">
          <span>Description</span>

          <textarea
            value={description}
            onChange={(e) =>
              setDescription(e.target.value)
            }
            rows={3}
            placeholder="What triggers this webhook?"
          />
        </label>

        <div className="setting-toggle">
          <div>
            <b>Enabled</b>

            <p>
              Accept inbound deliveries at this
              endpoint.
            </p>
          </div>

          <Toggle
            label="Enable webhook endpoint"
            value={enabled}
            onChange={setEnabled}
          />
        </div>
      </div>
    </Drawer>
  );
}