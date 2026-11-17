import { useCallback, useEffect, useRef, useState } from "react";
import type { FilterGroup } from "../components/FilterBuilder";
import { api, json } from "./api";
import { useApp } from "../context/AppContext";
import {
  applyFilterGroup,
  PG_FILTER_RESOURCES,
  sanitizeFilterGroup,
} from "./filterGroup";

type ResourceOptions = {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  q?: string;
  filters?: FilterGroup | null;
  all?: boolean;
};

type ResourceResponse<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
};

function positiveInteger(value: number | undefined, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

export function useResource<T extends { id: string }>(
  resource: string,
  options: ResourceOptions = {},
) {
  const { toast } = useApp();
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  // Only complete, backend-valid conditions may be serialized. Sending a
  // half-filled rule makes parseFilters() answer 400.
  const sanitizedFilters = sanitizeFilterGroup(options.filters);
  const filters = sanitizedFilters ? JSON.stringify(sanitizedFilters) : "";
  // PG-backed resources reject any advanced `filters` param, so those groups
  // are evaluated locally instead of being sent to the server.
  const localFilters = PG_FILTER_RESOURCES.has(resource);
  const all = options.all === true;
  const page = positiveInteger(options.page, 1);
  const limit = positiveInteger(options.limit, 25);
  const sortBy = options.sortBy || "createdAt";
  const sortDir = options.sortDir || "desc";
  const q = (options.q ?? "").trim();

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    if (all) setItems([]);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        sortBy,
        sortDir,
      });
      if (all) { params.delete("page"); params.delete("limit"); }
      if (q) params.set("q", q);
      if (filters && !localFilters) params.set("filters", filters);
      const result = await api<ResourceResponse<T> | T[]>(`/${resource}?${params}`);
      if (version !== requestVersion.current) return;
      const rows = Array.isArray(result) ? result : result.data;
      if (!Array.isArray(rows)) throw new Error("Invalid list response");
      const visible =
        localFilters && filters
          ? applyFilterGroup(rows, JSON.parse(filters) as FilterGroup)
          : rows;
      setItems(visible);
      // For array responses the whole set was fetched, so the local filter
      // result is the accurate count. Paginated responses keep the server
      // total (the filter only narrows the rows already on this page).
      setTotal(Array.isArray(result) ? visible.length : result.total);
    } catch (error) {
      if (version !== requestVersion.current) return;
      setError((error as Error).message);
      toast((error as Error).message, "error");
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [limit, page, q, resource, sortBy, sortDir, filters, all]);

  useEffect(() => {
    load();
    return () => { requestVersion.current++; };
  }, [load]);

  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ resource?: string }>).detail;
      if (!detail?.resource || detail.resource === resource) load();
    };
    window.addEventListener("tunaxa:resource-changed", refresh);
    return () => window.removeEventListener("tunaxa:resource-changed", refresh);
  }, [resource, load]);

  function changed() {
    window.dispatchEvent(
      new CustomEvent("tunaxa:resource-changed", { detail: { resource } }),
    );
  }

  async function create(data: Omit<T, "id"> | Record<string, unknown>) {
    try {
      const item = await api<T>(`/${resource}`, json("POST", data));
      setItems((current) => [
        item,
        ...current.filter((row) => row.id !== item.id),
      ]);
      toast("Saved");
      changed();
      return item;
    } catch (error) {
      toast((error as Error).message, "error");
      throw error;
    }
  }

  async function update(id: string, data: Partial<T>) {
    try {
      const item = await api<T>(`/${resource}/${id}`, json("PUT", data));
      setItems((current) => current.map((row) => (row.id === id ? item : row)));
      toast("Changes saved");
      changed();
      return item;
    } catch (error) {
      toast((error as Error).message, "error");
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
      toast((error as Error).message, "error");
      throw error;
    }
  }

  // With all: true the full dataset is already in `items`, so there is one
  // logical page and nothing left to fetch.
  const totalPages = all ? 1 : Math.max(1, Math.ceil(total / limit));
  const hasMore = all ? false : page < totalPages;

  return {
    items,
    setItems,
    loading,
    error,
    total,
    page,
    limit,
    totalPages,
    hasMore,
    load,
    reload: load,
    create,
    update,
    remove,
  };
}
