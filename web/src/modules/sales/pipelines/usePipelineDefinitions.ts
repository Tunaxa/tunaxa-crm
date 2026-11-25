import { useCallback, useEffect, useRef, useState } from "react";
import { api, json } from "../../../lib/api";
import {
  definitionPayload,
  parseDefinition,
  parseDefinitions,
  type PipelineDefinition,
  type PipelinePayload,
} from "./pipelineDefinitions";

type ApiFailure = Error & { status?: number };

function failureMessage(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message.trim() ? failure.message : fallback;
}

function rethrowConfirmed(failure: unknown, fallback: string): never {
  const status = (failure as ApiFailure).status;
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 408) throw failure;
  throw new Error(fallback);
}

export function usePipelineDefinitions() {
  const [definitions, setDefinitions] = useState<PipelineDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const version = useRef(0);
  const mounted = useRef(true);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    const request = ++version.current;
    try {
      const rows = parseDefinitions(await api("/pipeline-definitions"));
      if (mounted.current && request === version.current) {
        setDefinitions(rows);
        setError("");
        setUnavailable(false);
      }
    } catch (failure) {
      if (mounted.current && request === version.current) {
        const missing = (failure as ApiFailure).status === 404;
        setUnavailable(missing);
        setError(missing ? "Multiple pipelines are not available on this server yet. You can still view the existing board." : failureMessage(failure, "Could not load pipelines"));
      }
    } finally {
      if (mounted.current && request === version.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = (event: Event) => {
      const resource = (event as CustomEvent<{ resource?: string }>).detail?.resource;
      if (!resource || resource === "pipelineDefinitions") void load();
    };
    const focus = () => void load();
    window.addEventListener("tunaxa:resource-changed", refresh);
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      version.current += 1;
      window.removeEventListener("tunaxa:resource-changed", refresh);
      window.removeEventListener("focus", focus);
    };
  }, [load]);

  async function save(id: string | undefined, payload: PipelinePayload) {
    if (busy.current) throw new Error("Wait for the current pipeline save");
    busy.current = true;
    version.current += 1;
    setSaving(true);
    try {
      const saved = parseDefinition(await api(
        `/pipeline-definitions${id ? `/${encodeURIComponent(id)}` : ""}`,
        json(id ? "PUT" : "POST", payload),
      ));
      if (
        (id && saved.id !== id) ||
        saved.name !== payload.name ||
        saved.entityType !== payload.entityType ||
        saved.isDefault !== payload.isDefault ||
        saved.stages.length !== payload.stages.length ||
        saved.stages.some((stage, index) => {
          const requested = payload.stages[index];
          return stage.key !== requested.key || stage.label !== requested.label ||
            stage.probability !== requested.probability || stage.order !== requested.order;
        })
      ) {
        throw new Error("The server did not confirm the pipeline changes. Reload before trying again.");
      }
      if (mounted.current) {
        setDefinitions((current) => id ? current.map((row) => row.id === id ? saved : row) : [...current, saved]);
      }
      return saved;
    } catch (failure) {
      rethrowConfirmed(failure, "Pipeline save could not be confirmed. Check the refreshed pipeline list before saving again.");
    } finally {
      busy.current = false;
      if (mounted.current) {
        await load();
        if (mounted.current) setSaving(false);
      }
    }
  }

  async function setDefault(id: string) {
    const current = definitions.find((row) => row.id === id);
    if (!current) throw new Error("This pipeline is no longer available. Reload the list.");
    if (busy.current) throw new Error("Wait for the current pipeline save");
    const payload = definitionPayload(current, { isDefault: true });
    busy.current = true;
    version.current += 1;
    setSaving(true);
    try {
      const saved = parseDefinition(await api(`/pipeline-definitions/${encodeURIComponent(id)}`, json("PUT", payload)));
      if (saved.id !== id || !saved.isDefault) {
        throw new Error("The server did not confirm the default pipeline. Reload before trying again.");
      }
    } catch (failure) {
      rethrowConfirmed(failure, "Could not set the default pipeline. Check the refreshed list before trying again.");
    } finally {
      busy.current = false;
      if (mounted.current) {
        await load();
        if (mounted.current) setSaving(false);
      }
    }
  }

  async function remove(id: string) {
    if (busy.current) throw new Error("Wait for the current pipeline save");
    busy.current = true;
    version.current += 1;
    setSaving(true);
    try {
      const result = await api<{ ok: boolean; id: string }>(`/pipeline-definitions/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!result?.ok || result.id !== id) throw new Error("The server did not confirm the pipeline deletion");
    } catch (failure) {
      rethrowConfirmed(failure, "Could not delete the pipeline. Check the refreshed list before trying again.");
    } finally {
      busy.current = false;
      if (mounted.current) {
        await load();
        if (mounted.current) setSaving(false);
      }
    }
  }

  return { definitions, loading, error, unavailable, saving, load, save, setDefault, remove };
}
