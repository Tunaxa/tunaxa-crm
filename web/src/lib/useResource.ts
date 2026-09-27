import { useCallback, useEffect, useState } from "react";
import { api, json } from "./api";
import { useApp } from "../context/AppContext";

type ResourceOptions = {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  q?: string;
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
  const page = options.page || 1;
  const limit = options.limit || 25;
  const sortBy = options.sortBy || "createdAt";
  const sortDir = options.sortDir || "desc";
  const q = options.q || "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        sortBy,
        sortDir,
      });
      if (q) params.set("q", q);
      const result = await api<ResourceResponse<T>>(`/${resource}?${params}`);
      setItems(result.data);
      setTotal(result.total);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [limit, page, q, resource, sortBy, sortDir]);

  useEffect(() => {
    load();
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

  return { items, setItems, loading, total, page, limit, load, create, update, remove };
}
