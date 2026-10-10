import { useCallback, useEffect, useRef, useState } from "react";
import { api, json } from "../../../lib/api";
import { assertSlackSaved, integrationError, parseIntegrations, slackPayload, type Integrations } from "./integrationModel";

export function useIntegrations() {
  const [config, setConfig] = useState<Integrations | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true), version = useRef(0), busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    const request = ++version.current;
    setLoading(true);
    try {
      const next = parseIntegrations(await api("/integrations"));
      if (mounted.current && request === version.current) { setConfig(next); setError(""); }
    } catch (failure) {
      if (mounted.current && request === version.current) setError(integrationError(failure, "load"));
    } finally { if (mounted.current && request === version.current) setLoading(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = (event: Event) => {
      const resource = (event as CustomEvent<{ resource?: string }>).detail?.resource;
      if (!resource || resource === "integrations") void load();
    };
    const focus = () => { void load(); };
    window.addEventListener("tunaxa:resource-changed", refresh);
    window.addEventListener("focus", focus);
    return () => { mounted.current = false; version.current++; window.removeEventListener("tunaxa:resource-changed", refresh); window.removeEventListener("focus", focus); };
  }, [load]);

  async function saveSlack(value: string) {
    const payload = slackPayload(value);
    if (busy.current) throw new Error("Wait for the current configuration save");
    busy.current = true; version.current++; setSaving(true);
    try {
      const saved = assertSlackSaved(await api("/integrations/slack", json("PUT", payload)), payload);
      if (mounted.current) { setConfig(saved); setError(""); }
      return saved;
    } catch (failure) { throw new Error(integrationError(failure, "save")); }
    finally {
      busy.current = false;
      if (mounted.current) { await load(); if (mounted.current) setSaving(false); }
    }
  }
  return { config, loading, saving, error, load, saveSlack };
}
