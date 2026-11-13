import React, { useId } from "react";
import {
  useController,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";

export interface FormSelectOption {
  value: string;
  label: string;
}

export interface FormSelectProps<T extends FieldValues>
  extends Omit<
    React.SelectHTMLAttributes<HTMLSelectElement>,
    "name" | "id" | "value" | "defaultValue"
  > {
  name: FieldPath<T>;
  control: Control<T>;
  label: string;
  options: FormSelectOption[];
  hint?: string;
  placeholder?: string;
}

export function FormSelect<T extends FieldValues>({
  name,
  control,
  label,
  options,
  hint,
  placeholder = "Select an option",
  disabled = false,
  required,
  ...rest
}: FormSelectProps<T>) {
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

      <select
        {...rest}
        {...field}
        id={fieldId}
        disabled={disabled}
        required={required}
        value={field.value ?? ""}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={describedBy}
      >
        <option value="">{placeholder}</option>

        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

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
