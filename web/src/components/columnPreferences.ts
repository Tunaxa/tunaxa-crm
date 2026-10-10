export type ColumnOption = { key: string; label: string; required?: boolean };
type StorageReader = Pick<Storage, "getItem">;

export function columnPreferenceKey(resource: string, userId: string) {
  return `tunaxa:columns:v1:${encodeURIComponent(userId)}:${encodeURIComponent(resource)}`;
}

export function readHiddenColumns(storage: StorageReader, key: string): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) || "[]");
    return Array.isArray(value) && value.every(item => typeof item === "string") ? [...new Set(value)] : [];
  } catch {
    return [];
  }
}

export function visibleColumnKeys(columns: ColumnOption[], hidden: string[]) {
  return columns.filter(column => column.required || !hidden.includes(column.key)).map(column => column.key);
}
