import React, { useId } from "react";
import {
  useController,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";

export interface FormTextareaProps<T extends FieldValues>
  extends Omit<
    React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    "name" | "id" | "value" | "defaultValue"
  > {
  name: FieldPath<T>;
  control: Control<T>;
  label: string;
  hint?: string;
}

export function FormTextarea<T extends FieldValues>({
  name,
  control,
  label,
  hint,
  placeholder,
  rows = 4,
  disabled = false,
  required,
  ...rest
}: FormTextareaProps<T>) {
  const {
    field,
    fieldState: { error },
  } = useController({ name, control });

  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div className="form-field">
      <label className="form-field-label" htmlFor={fieldId}>
        {label}
      </label>

      <textarea
        {...rest}
        {...field}
        id={fieldId}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        required={required}
        value={field.value ?? ""}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={describedBy}
      />

      {hint ? (
        <p id={hintId} className="form-field-hint">
          {hint}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} role="alert" className="form-field-error">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}
