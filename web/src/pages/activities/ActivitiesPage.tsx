import { useState, type ComponentType, type ReactNode } from "react";
import { Badge } from "../../components/ui";
import { useResource } from "../../lib/useResource";

type Row = { id: string; [key: string]: any };

type FieldSpec = {
  key: string;
  label: string;
  type?: string;
  options?: string[];
  required?: boolean;
  placeholder?: string;
};

type ActivitiesPageProps = {
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

export function ActivitiesPage({
  SimpleCards,
  RecordForm,
}: ActivitiesPageProps) {
  const { items, create, update, remove } = useResource<Row>("activities");
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);

  const fields: FieldSpec[] = [
    { key: "title", label: "Activity title" },
    {
      key: "type",
      label: "Type",
      type: "select",
      options: ["Note", "Meeting", "Email", "SMS", "Call"],
    },
    { key: "contact", label: "Contact" },
    { key: "date", label: "Date", type: "date" },
    { key: "notes", label: "Notes", type: "textarea" },
  ];

  return (
    <SimpleCards
      title="Activities"
      description="Meetings, notes and customer touchpoints."
      icon="activity"
      items={items}
      onAdd={() => setEdit(null)}
      onEdit={setEdit}
      onDelete={remove}
      render={(item) => (
        <>
          <div className="activity-item-head">
            <Badge tone="blue">{item.type || "Note"}</Badge>
            <small>
              {item.date || new Date(item.createdAt).toLocaleDateString()}
            </small>
          </div>
          <h3>{item.title || "Untitled activity"}</h3>
          <p>{item.contact || item.notes || "No details"}</p>
        </>
      )}
      modal={
        edit !== undefined ? (
          <RecordForm
            title={`${edit ? "Edit" : "Add"} activity`}
            fields={fields}
            initial={edit || {}}
            onClose={() => setEdit(undefined)}
            onSave={async (data) => {
              edit ? await update(edit.id, data) : await create(data);
              setEdit(undefined);
            }}
          />
        ) : null
      }
    />
  );
}