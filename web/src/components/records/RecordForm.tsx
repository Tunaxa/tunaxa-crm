import { type FieldSpec, type Row } from "./types";
import { type ReactNode, useState } from "react";
import { useApp } from "../../context/AppContext";
import { useForm } from "react-hook-form";
import { Drawer, PhotoField } from "../ui";

export function RecordForm({
  title,
  fields,
  initial,
  onClose,
  onSave,
  toolbar,
}: {
  title: string;
  fields: FieldSpec[];
  initial: Row | Record<string, any>;
  onClose: () => void;
  onSave: (data: Record<string, any>) => Promise<void>;
  toolbar?: ReactNode;
}) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);

  const defaultValues = Object.fromEntries(
    fields.map((field) => [
      field.key,
      initial[field.key] ??
        (field.type === "select"
          ? field.options?.[0] || ""
          : field.type === "checkbox"
            ? false
            : ""),
    ]),
  );

  const {
    register,
    handleSubmit,
    watch,
    setValue,
  } = useForm<Record<string, any>>({
    defaultValues,
  });

  async function save(data: Record<string, any>) {
    const missing = fields.find(
      (field) => field.required && !String(data[field.key] ?? "").trim(),
    );

    if (missing) {
      return toast(`${missing.label} is required`, "error");
    }

    setBusy(true);

    try {
      await onSave(data);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={title}
      subtitle="Changes are saved directly to your workspace."
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>

          <button
            className="btn primary"
            disabled={busy}
            onClick={handleSubmit(save)}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="drawer-form">
        {toolbar}

        {fields.map((field) =>
          field.type === "photo" ? (
            <PhotoField
              key={field.key}
              label={field.label}
              name={String(watch("name") || watch("title") || "")}
              value={watch(field.key)}
              onChange={(url: string) => setValue(field.key, url)}
            />
          ) : field.type === "checkbox" ? (
            <label className="toggle-row" key={field.key}>
              <input type="checkbox" {...register(field.key)} />
              <span>{field.label}</span>
            </label>
          ) : (
            <label className="field" key={field.key}>
              <span>
                {field.label}
                {field.required ? (
                  <em className="required-mark">*</em>
                ) : null}
              </span>

              {field.type === "select" ? (
                <select {...register(field.key)}>
                  {field.options?.map((option) => (
                    <option key={option} value={option}>
                      {field.optionLabels?.[option] || option}
                    </option>
                  ))}
                </select>
              ) : field.type === "textarea" ? (
                <textarea
                  {...register(field.key)}
                  placeholder={field.placeholder}
                  rows={6}
                />
              ) : (
                <input
                  type={field.type || "text"}
                  {...register(field.key, {
                    setValueAs: (value) =>
                      field.type === "number"
                        ? Number(value)
                        : value,
                  })}
                  placeholder={field.placeholder}
                />
              )}
            </label>
          ),
        )}
      </div>
    </Drawer>
  );
}
