import { useCallback, useEffect, useRef, useState } from "react";
import type { FilterGroup } from "../components/FilterBuilder";
import { api, json } from "./api";
import { useApp } from "../context/AppContext";

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
  const filters = options.filters ? JSON.stringify(options.filters) : "";
  const all = options.all === true;
  const page = options.page || 1;
  const limit = options.limit || 25;
  const sortBy = options.sortBy || "createdAt";
  const sortDir = options.sortDir || "desc";
  const q = options.q || "";

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
      if (filters) params.set("filters", filters);
      const result = await api<ResourceResponse<T> | T[]>(`/${resource}?${params}`);
      if (version !== requestVersion.current) return;
      const rows = Array.isArray(result) ? result : result.data;
      if (!Array.isArray(rows)) throw new Error("Invalid list response");
      setItems(rows);
      setTotal(Array.isArray(result) ? result.length : result.total);
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

  return { items, setItems, loading, error, total, page, limit, load, create, update, remove };
}
