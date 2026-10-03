import React from "react";
import {
  useController,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";

interface FormInputProps<T extends FieldValues> {
  name: FieldPath<T>;
  control: Control<T>;
  label: string;
  type?: React.InputHTMLAttributes<HTMLInputElement>["type"];
  placeholder?: string;
  disabled?: boolean;
}

export function FormInput<T extends FieldValues>({
  name,
  control,
  label,
  type = "text",
  placeholder,
  disabled = false,
}: FormInputProps<T>) {
  const {
    field,
    fieldState: { error },
  } = useController({ name, control });

  const errorId = `${String(name)}-error`;

  return (
    <div className="form-field">
      <label htmlFor={String(name)}>{label}</label>

      <input
        {...field}
        id={String(name)}
        type={type}
        placeholder={placeholder}
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