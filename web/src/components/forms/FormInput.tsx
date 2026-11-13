import React, { useId } from "react";
import {
  useController,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";

export interface FormInputProps<T extends FieldValues>
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "name" | "id" | "value" | "defaultValue"
  > {
  name: FieldPath<T>;
  control: Control<T>;
  label: string;
  hint?: string;
}

export function FormInput<T extends FieldValues>({
  name,
  control,
  label,
  hint,
  type = "text",
  placeholder,
  disabled = false,
  required,
  ...rest
}: FormInputProps<T>) {
  const {
    field,
    fieldState: { error },
  } = useController({ name, control });

  // Ids are generated per instance so multiple forms can coexist on one page
  // without colliding on id / htmlFor / aria-describedby.
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

      <input
        {...rest}
        {...field}
        id={fieldId}
        type={type}
        placeholder={placeholder}
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
