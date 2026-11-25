export type Row = { id: string; [key: string]: any };

export type FieldType =
  | "text"
  | "number"
  | "email"
  | "date"
  | "select"
  | "textarea"
  | "checkbox"
  | "photo";

export type FieldSpec = {
  key: string;
  label: string;
  type?: FieldType | string;
  options?: string[];
  optionLabels?: Record<string, string>;
  required?: boolean;
  placeholder?: string;
  readOnly?: boolean;
  hidden?: boolean;
  masked?: boolean;
  custom?: boolean;
};

export type BadgeTone = "neutral" | "blue" | "green" | "amber" | "red" | "purple";
