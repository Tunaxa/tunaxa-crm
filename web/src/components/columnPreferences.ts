import { useEffect, useRef, useState } from "react";
import { api, getToken, json } from "../lib/api";

export type ColumnOption = { key: string; label: string; required?: boolean };

export const MAX_COLUMN_KEYS = 200;

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type ColumnSchema = {
  hiddenFields?: unknown;
  maskedFields?: unknown;
  fields?: Array<{
    key?: unknown;
    name?: unknown;
    hidden?: unknown;
    masked?: unknown;
  }>;
};

type PreferencesResponse = {
  preferences?: { columnVisibility?: unknown } | null;
  columnVisibility?: unknown;
};

export function columnCacheKey(
  workspaceId: string,
  userId: string,
  resource: string,
) {
  return `tunaxa:columns:v2:${encodeURIComponent(workspaceId || "default")}:${encodeURIComponent(userId || "anonymous")}:${encodeURIComponent(resource)}`;
}

export function workspaceIdOf(user: unknown) {
  const source =
    user && typeof user === "object"
      ? (user as Record<string, unknown>)
      : null;
  const fromStorage =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("tunaxa.workspace")
      : null;
  const fromUser = source?.workspaceId ?? source?.workspace_id;
  return (
    fromStorage || (typeof fromUser === "string" ? fromUser : "") || "default"
  );
}

export function normalizeColumnKey(value: unknown) {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.length > 100) return null;
  if (DANGEROUS_KEYS.has(key)) return null;
  if (key.includes(".") || key.includes("[") || key.includes("]")) return null;
  return key;
}

export function sanitizeVisibleKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  requiredKeys: readonly string[] = [],
) {
  const seen = Object.create(null) as Record<string, true>;
  const keys: string[] = [];
  const add = (raw: unknown) => {
    const key = normalizeColumnKey(raw);
    if (!key || !allowed.has(key)) return;
    if (Object.prototype.hasOwnProperty.call(seen, key)) return;
    seen[key] = true;
    if (keys.length < MAX_COLUMN_KEYS) keys.push(key);
  };
  requiredKeys.forEach(add);
  if (value === true) allowed.forEach(add);
  else if (Array.isArray(value)) value.forEach(add);
  return keys;
}

export function sanitizeKeyList(value: readonly string[]) {
  const seen = Object.create(null) as Record<string, true>;
  const keys: string[] = [];
  for (const item of value) {
    const key = normalizeColumnKey(item);
    if (!key || Object.prototype.hasOwnProperty.call(seen, key)) continue;
    seen[key] = true;
    if (keys.length < MAX_COLUMN_KEYS) keys.push(key);
  }
  return keys;
}

export function readResourceVisibility(
  payload: unknown,
  resource: string,
  allowed: ReadonlySet<string>,
  requiredKeys: readonly string[],
) {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const nested = root.preferences;
  const source =
    nested && typeof nested === "object"
      ? (nested as Record<string, unknown>)
      : root;
  if (!Object.prototype.hasOwnProperty.call(source, "columnVisibility")) {
    return null;
  }
  const visibility = source.columnVisibility;
  if (!visibility || typeof visibility !== "object" || Array.isArray(visibility)) {
    return null;
  }
  const map = visibility as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(map, resource)) return null;
  return sanitizeVisibleKeys(map[resource], allowed, requiredKeys);
}

export function toColumnVisibility(
  resource: string,
  keys: readonly string[],
  allowed?: ReadonlySet<string>,
) {
  const map = Object.create(null) as Record<string, string[]>;
  map[resource] = sanitizeKeyList(keys).filter(
    (key) => !allowed || allowed.has(key),
  );
  return map;
}

export function readCachedKeys(
  storage: Pick<Storage, "getItem">,
  key: string,
  allowed: ReadonlySet<string>,
  requiredKeys: readonly string[],
) {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return sanitizeVisibleKeys(parsed, allowed, requiredKeys);
  } catch {
    return null;
  }
}

export function writeCachedKeys(
  storage: Pick<Storage, "setItem">,
  key: string,
  keys: readonly string[],
) {
  try {
    storage.setItem(key, JSON.stringify(sanitizeKeyList(keys)));
  } catch {
    return;
  }
}

export function restrictedColumnKeys(schema: ColumnSchema | null | undefined) {
  const restricted = new Set<string>();
  if (!schema) return restricted;
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      const key = normalizeColumnKey(item);
      if (key) restricted.add(key);
    }
  };
  collect(schema.hiddenFields);
  collect(schema.maskedFields);
  if (Array.isArray(schema.fields)) {
    for (const field of schema.fields) {
      if (!field || typeof field !== "object") continue;
      if (field.hidden !== true && field.masked !== true) continue;
      const key = normalizeColumnKey(field.key ?? field.name);
      if (key) restricted.add(key);
    }
  }
  return restricted;
}

export function filterRestrictedColumns(
  columns: ColumnOption[],
  schema: ColumnSchema | null | undefined,
) {
  const restricted = restrictedColumnKeys(schema);
  if (!restricted.size) return columns;
  return columns.filter((column) => !restricted.has(column.key));
}

export function useColumnSchema(resource: string) {
  const [schema, setSchema] = useState<ColumnSchema | null>(null);
  useEffect(() => {
    let active = true;
    setSchema(null);
    api<ColumnSchema>(`/schema/${encodeURIComponent(resource)}`)
      .then((next) => {
        if (active) setSchema(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [resource]);
  return schema;
}

export function useColumnPreferences(
  resource: string,
  columns: ColumnOption[],
  userId: string,
  workspaceId: string,
) {
  const keys = columns.map((column) => column.key);
  const signature = keys.join("\u0000");
  const allowed = new Set(keys);
  const required = columns
    .filter((column) => column.required)
    .map((column) => column.key);
  const cacheKey = columnCacheKey(workspaceId, userId, resource);
  const allVisible = () => sanitizeVisibleKeys(true, allowed, required);
  const [visibleKeys, setVisibleKeys] = useState<string[]>(() => {
    if (typeof localStorage === "undefined") return allVisible();
    return (
      readCachedKeys(localStorage, cacheKey, allowed, required) ?? allVisible()
    );
  });
  const [saveError, setSaveError] = useState("");
  const committed = useRef<string[]>(visibleKeys);

  useEffect(() => {
    let active = true;
    const cached =
      typeof localStorage === "undefined"
        ? null
        : readCachedKeys(localStorage, cacheKey, allowed, required);
    const initial = cached ?? allVisible();
    committed.current = initial;
    setVisibleKeys(initial);
    setSaveError("");
    if (getToken()) {
      api<PreferencesResponse>("/user/preferences")
        .then((payload) => {
          if (!active) return;
          const serverKeys = readResourceVisibility(
            payload,
            resource,
            allowed,
            required,
          );
          if (!serverKeys) return;
          committed.current = serverKeys;
          setVisibleKeys(serverKeys);
          if (typeof localStorage !== "undefined") {
            writeCachedKeys(localStorage, cacheKey, serverKeys);
          }
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [resource, cacheKey, userId, signature]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = (event: StorageEvent) => {
      if (event.key !== cacheKey && event.key !== null) return;
      const cached = readCachedKeys(localStorage, cacheKey, allowed, required);
      if (!cached) return;
      committed.current = cached;
      setVisibleKeys(cached);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [cacheKey, signature]);

  function change(next: string[]) {
    const clean = sanitizeVisibleKeys(next, allowed, required);
    const previous = committed.current;
    setVisibleKeys(clean);
    committed.current = clean;
    if (typeof localStorage !== "undefined") {
      writeCachedKeys(localStorage, cacheKey, clean);
    }
    setSaveError("");
    if (!getToken()) return;
    api(
      "/user/preferences",
      json("PATCH", {
        columnVisibility: toColumnVisibility(resource, clean, allowed),
      }),
    ).catch(() => {
      committed.current = previous;
      setVisibleKeys(previous);
      if (typeof localStorage !== "undefined") {
        writeCachedKeys(localStorage, cacheKey, previous);
      }
      setSaveError(
        "Your column choices could not be saved. Previous choices were restored.",
      );
    });
  }

  return {
    visibleKeys,
    hidden: keys.filter((key) => !visibleKeys.includes(key)),
    change,
    saveError,
  };
}
