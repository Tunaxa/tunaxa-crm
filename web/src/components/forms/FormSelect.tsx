import React from "react";
import {
  useController,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";

interface FormSelectOption {
  value: string;
  label: string;
}

interface FormSelectProps<T extends FieldValues> {
  name: FieldPath<T>;
  control: Control<T>;
  label: string;
  options: FormSelectOption[];
  placeholder?: string;
  disabled?: boolean;
}

export function FormSelect<T extends FieldValues>({
  name,
  control,
  label,
  options,
  placeholder = "Select an option",
  disabled = false,
}: FormSelectProps<T>) {
  const {
    field,
    fieldState: { error },
  } = useController({ name, control });

  const errorId = `${String(name)}-error`;

  return (
    <div className="form-field">
      <label htmlFor={String(name)}>{label}</label>

      <select
        {...field}
        id={String(name)}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
      >
        <option value="">{placeholder}</option>

        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {error && (
        <p id={errorId} role="alert" className="form-field-error">
          {error.message}
        </p>
      )}
    </div>
  );
}