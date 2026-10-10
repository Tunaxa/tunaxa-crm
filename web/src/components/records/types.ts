

export type Row = { id: string; [key: string]: any };

export type FieldSpec = {
  key: string;
  label: string;
  type?: string;
  options?: string[];
  optionLabels?: Record<string, string>;
  required?: boolean;
  placeholder?: string;
};

export type BadgeTone = "neutral" | "blue" | "green" | "amber" | "red" | "purple";
