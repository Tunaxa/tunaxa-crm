import { useCallback, useEffect, useRef, useState } from "react";
import { api, json } from "../../../lib/api";
import { parseDefinition, parseDefinitions, type PipelineDefinition, type pipelinePayload } from "./pipelineDefinitions";

export function usePipelineDefinitions() {
  const [definitions, setDefinitions] = useState<PipelineDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const version = useRef(0), mounted = useRef(true), busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    const request = ++version.current;
    try {
      const rows = parseDefinitions(await api("/pipeline/definitions"));
      if (mounted.current && request === version.current) { setDefinitions(rows); setError(""); setUnavailable(false); }
    } catch (failure) {
      if (mounted.current && request === version.current) {
        const missing = (failure as { status?: number }).status === 404;
        setUnavailable(missing);
        setError(missing ? "Multiple pipelines are not available on this server yet. You can still view the existing board." : (failure as Error).message);
      }
    } finally { if (mounted.current && request === version.current) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = (event: Event) => {
      const resource = (event as CustomEvent<{ resource?: string }>).detail?.resource;
      if (!resource || resource === "pipelineDefinitions") void load();
    };
    const focus = () => { void load(); };
    window.addEventListener("tunaxa:resource-changed", refresh);
    window.addEventListener("focus", focus);
    return () => { mounted.current = false; version.current++; window.removeEventListener("tunaxa:resource-changed", refresh); window.removeEventListener("focus", focus); };
  }, [load]);
  async function save(id: string | undefined, payload: ReturnType<typeof pipelinePayload>) {
    if (busy.current) throw new Error("Wait for the current pipeline save");
    busy.current = true; version.current++; setSaving(true);
    try {
      const saved = parseDefinition(await api(`/pipeline/definitions${id ? `/${encodeURIComponent(id)}` : ""}`, json(id ? "PUT" : "POST", payload)));
      if ((id && saved.id !== id) || saved.name !== payload.name || saved.stages.length !== payload.stages.length || saved.stages.some((stage, index) => {
        const requested = payload.stages[index];
        return stage.key !== requested.key || stage.label !== requested.label || stage.probability !== requested.probability || stage.order !== requested.order;
      })) throw new Error("The server did not confirm the pipeline changes. Reload before trying again.");
      if (mounted.current) setDefinitions(current => id ? current.map(row => row.id === id ? saved : row) : [...current, saved]);
      return saved;
    } catch (failure) {
      const status = (failure as { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 408) throw failure;
      throw new Error("Pipeline save could not be confirmed. Check the refreshed pipeline list before saving again.");
    } finally { busy.current = false; if (mounted.current) { await load(); if (mounted.current) setSaving(false); } }
  }
  return { definitions, loading, error, unavailable, saving, load, save };
}
