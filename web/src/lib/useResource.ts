
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, json } from "./api";
import { useApp } from "../context/AppContext";

type FilterValue = string | number | boolean | undefined;

type ResourceOptions = {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  q?: string;
  filters?: Record<string, FilterValue>;
};

type ResourceResponse<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages?: number;
  hasMore?: boolean;
};

export function useResource<T extends { id: string }>(
  resource: string,
  options: ResourceOptions = {},
) {
  const { toast } = useApp();

  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  const page = options.page ?? 1;
  const limit = options.limit ?? 25;
  const sortBy = options.sortBy ?? "createdAt";
  const sortDir = options.sortDir ?? "desc";
  const q = options.q ?? "";

  // Keep filters stable even when callers pass a new object on each render.
  // Empty and undefined values are omitted; false and 0 are preserved.
  const filtersKey = JSON.stringify(
    Object.entries(options.filters ?? {})
      .filter(([, value]) => value !== undefined && value !== "")
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB)),
  );

  const filters = useMemo(
    () =>
      Object.fromEntries(
        JSON.parse(filtersKey) as [string, Exclude<FilterValue, undefined> ][],
      ) as Record<string, Exclude<FilterValue, undefined>>,
    [filtersKey],
  );

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        sortBy,
        sortDir,
      });

      if (q.trim()) {
        params.set("q", q.trim());
      }

      Object.entries(filters).forEach(([key, value]) => {
        params.set(key, String(value));
      });

      const result = await api<ResourceResponse<T>>(
        `/${resource}?${params.toString()}`,
      );

      setItems(result.data);
      setTotal(result.total);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Failed to load resource",
        "error",
      );
    } finally {
      setLoading(false);
    }
  }, [filters, limit, page, q, resource, sortBy, sortDir, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ resource?: string }>).detail;

      if (!detail?.resource || detail.resource === resource) {
        void load();
      }
    };

    window.addEventListener("tunaxa:resource-changed", refresh);

    return () => {
      window.removeEventListener("tunaxa:resource-changed", refresh);
    };
  }, [resource, load]);

  const changed = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("tunaxa:resource-changed", {
        detail: { resource },
      }),
    );
  }, [resource]);

  async function create(data: Omit<T, "id"> | Record<string, unknown>) {
    try {
      const item = await api<T>(
        `/${resource}`,
        json("POST", data),
      );

      setItems((current) => [
        item,
        ...current.filter((row) => row.id !== item.id),
      ]);

      toast("Saved");
      changed();

      return item;
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Failed to create resource",
        "error",
      );
      throw error;
    }
  }

  async function update(id: string, data: Partial<T>) {
    try {
      const item = await api<T>(
        `/${resource}/${id}`,
        json("PUT", data),
      );

      setItems((current) =>
        current.map((row) => (row.id === id ? item : row)),
      );

      toast("Changes saved");
      changed();

      return item;
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Failed to update resource",
        "error",
      );
      throw error;
    }
  }

  async function remove(id: string) {
    try {
      await api(`/${resource}/${id}`, json("DELETE"));

      setItems((current) => current.filter((row) => row.id !== id));

      toast("Deleted");
      changed();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Failed to delete resource",
        "error",
      );
      throw error;
    }
  }

  return {
    items,
    setItems,
    loading,
    total,
    page,
    limit,
    load,
    create,
    update,
    remove,
  };
}
