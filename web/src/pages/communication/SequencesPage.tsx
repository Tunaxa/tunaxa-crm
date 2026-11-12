import { useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Badge, Toggle } from "../../components/ui";
import { useResource } from "../../lib/useResource";

type Row = {
  id: string;
  [key: string]: any;
};

type FieldSpec = {
  key: string;
  label: string;
  type?: string;
  options?: string[];
  required?: boolean;
  placeholder?: string;
};

type SequencesPageProps = {
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
  RecordForm: ComponentType<{
    title: string;
    fields: FieldSpec[];
    initial: Row | Record<string, any>;
    onClose: () => void;
    onSave: (data: Record<string, any>) => Promise<void>;
  }>;
};

export function SequencesPage({
  SimpleCards,
  RecordForm,
}: SequencesPageProps) {
  const { items, create, update, remove } =
    useResource<Row>("sequences");

  const [edit, setEdit] = useState<Row | null | undefined>(undefined);

  const fields: FieldSpec[] = [
    { key: "name", label: "Sequence name" },
    { key: "audience", label: "Audience / segment" },
    {
      key: "steps",
      label: "Steps description",
      type: "textarea",
    },
  ];

  return (
    <SimpleCards
      title="Sequences"
      description="Reusable multi-step outreach plans."
      icon="sequence"
      items={items}
      onAdd={() => setEdit(null)}
      onEdit={setEdit}
      onDelete={remove}
      render={(item) => (
        <>
          <div className="deal-top">
            <Badge tone={item.enabled ? "green" : "neutral"}>
              {item.enabled ? "Active" : "Paused"}
            </Badge>

            <Toggle
              label={`${item.enabled ? "Disable" : "Enable"} ${
                item.name || "sequence"
              }`}
              value={Boolean(item.enabled)}
              onChange={(enabled) =>
                update(item.id, { enabled })
              }
            />
          </div>

          <h3>{item.name || "Untitled sequence"}</h3>

          <p>
            {item.audience || "No audience selected"}
          </p>

          <small>
            {item.steps || "No steps added"}
          </small>
        </>
      )}
      modal={
        edit !== undefined ? (
          <RecordForm
            title={`${edit ? "Edit" : "New"} sequence`}
            fields={fields}
            initial={edit || {}}
            onClose={() => setEdit(undefined)}
            onSave={async (data) => {
              if (edit) {
                await update(edit.id, data);
              } else {
                await create({
                  ...data,
                  enabled: false,
                });
              }

              setEdit(undefined);
            }}
          />
        ) : null
      }
    />
  );
}