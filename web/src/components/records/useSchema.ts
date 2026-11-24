import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { sanitizeFieldKey } from "./urlSecurity";
import type { FieldSpec } from "./types";

export type SchemaField = {
  name?: unknown;
  key?: unknown;
  label?: unknown;
  type?: unknown;
  options?: unknown;
  required?: unknown;
  readOnly?: unknown;
  hidden?: unknown;
  masked?: unknown;
  custom?: unknown;
};

export type SchemaResponse = {
  customFields?: unknown;
  fields?: unknown;
  hiddenFields?: unknown;
  maskedFields?: unknown;
};

export type ParsedSchema = {
  fields: FieldSpec[];
  hiddenFields: string[];
  maskedFields: string[];
};

export type SchemaState = ParsedSchema & {
  loading: boolean;
  error: string;
};

const SYSTEM_KEYS = new Set(["id", "createdAt", "updatedAt", "created_by", "updated_by"]);

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function collectRestricted(value: unknown): string[] {
  const seen = new Set<string>();
  for (const item of arrayOf(value)) {
    const candidate =
      item && typeof item === "object"
        ? (item as SchemaField).key ?? (item as SchemaField).name
        : item;
    const key = sanitizeFieldKey(candidate);
    if (key && !seen.has(key)) seen.add(key);
  }
  return [...seen];
}

function toFieldType(value: unknown): string {
  const type = String(value ?? "").toLowerCase();
  if (["number", "currency", "integer", "decimal"].includes(type)) return "number";
  if (["date", "datetime", "timestamp"].includes(type)) return "date";
  if (["select", "dropdown", "enum"].includes(type)) return "select";
  if (["checkbox", "boolean"].includes(type)) return "checkbox";
  if (type === "textarea") return "textarea";
  if (["photo", "image"].includes(type)) return "photo";
  return "text";
}

function toOptions(value: unknown): string[] {
  const seen = new Set<string>();
  for (const option of arrayOf(value)) {
    const raw =
      option && typeof option === "object"
        ? (option as { value?: unknown; label?: unknown }).value ??
          (option as { label?: unknown }).label
        : option;
    if (typeof raw !== "string" || !raw.trim() || seen.has(raw.trim())) continue;
    seen.add(raw.trim());
  }
  return [...seen];
}

export function parseSchemaResponse(payload: unknown): ParsedSchema {
  const source = (payload && typeof payload === "object" ? payload : {}) as SchemaResponse;
  const hidden = new Set(collectRestricted(source.hiddenFields));
  const masked = new Set(collectRestricted(source.maskedFields));
  const candidates = arrayOf(source.customFields).length
    ? arrayOf(source.customFields)
    : arrayOf(source.fields).filter((field) => {
        if (!field || typeof field !== "object") return false;
        const spec = field as SchemaField;
        return spec.custom === true || spec.readOnly !== true;
      });

  const fields: FieldSpec[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const spec = item as SchemaField;
    const key = sanitizeFieldKey(spec.key ?? spec.name);
    if (!key || SYSTEM_KEYS.has(key) || seen.has(key)) continue;
    if (spec.readOnly === true || spec.hidden === true || spec.masked === true) continue;
    if (hidden.has(key) || masked.has(key)) continue;
    seen.add(key);
    const label = typeof spec.label === "string" && spec.label.trim() ? spec.label : key;
    fields.push({
      key,
      label,
      type: toFieldType(spec.type),
      options: toOptions(spec.options),
      required: Boolean(spec.required),
      custom: spec.custom === true || arrayOf(source.customFields).length > 0,
    });
  }

  return { fields, hiddenFields: [...hidden], maskedFields: [...masked] };
}

export function useSchema(object: string): SchemaState {
  const [state, setState] = useState<SchemaState>({
    fields: [],
    hiddenFields: [],
    maskedFields: [],
    loading: true,
    error: "",
  });

  useEffect(() => {
    let active = true;
    setState({
      fields: [],
      hiddenFields: [],
      maskedFields: [],
      loading: true,
      error: "",
    });
    api<SchemaResponse>(`/schema/${encodeURIComponent(object)}`)
      .then((payload) => {
        if (!active) return;
        setState({ ...parseSchemaResponse(payload), loading: false, error: "" });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          fields: [],
          hiddenFields: [],
          maskedFields: [],
          loading: false,
          error: error instanceof Error ? error.message : "Schema unavailable",
        });
      });
    return () => {
      active = false;
    };
  }, [object]);

  return state;
}
