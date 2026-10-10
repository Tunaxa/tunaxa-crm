import { type FieldSpec } from "./types";
import { useState, useEffect } from "react";
import { api } from "../../lib/api";

export function useSchema(object: string): FieldSpec[] {
  const [custom, setCustom] = useState<FieldSpec[]>([]);
  useEffect(() => {
    api<{ fields: FieldSpec[] }>(`/schema/${object}`)
      .then((schema) => setCustom(schema.fields))
      .catch(() => {});
  }, [object]);
  return custom;
}
