import React from "react";
import {
  useController,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";

interface FormTextareaProps<T extends FieldValues> {
  name: FieldPath<T>;
  control: Control<T>;
  label: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}

export function FormTextarea<T extends FieldValues>({
  name,
  control,
  label,
  placeholder,
  rows = 4,
  disabled = false,
}: FormTextareaProps<T>) {
  const {
    field,
    fieldState: { error },
  } = useController({ name, control });

  const errorId = `${String(name)}-error`;

  return (
    <div className="form-field">
      <label htmlFor={String(name)}>{label}</label>

      <textarea
        {...field}
        id={String(name)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
      />

      {error && (
        <p id={errorId} role="alert" className="form-field-error">
          {error.message}
        </p>
      )}
    </div>
  );
}