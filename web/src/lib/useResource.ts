import { useCallback, useEffect, useState } from "react";
import { api, json } from "./api";
import { useApp } from "../context/AppContext";

export function useResource<T extends { id: string }>(resource: string) {
  const { toast } = useApp();
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api<T[]>(`/${resource}`));
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [resource]);

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

  return { items, setItems, loading, load, create, update, remove };
}
