import { useCallback, useEffect, useRef, useState } from "react";
import { api, json } from "../../../lib/api";
import {
  assertSlackDisconnected,
  assertSlackSaved,
  integrationError,
  parseIntegrations,
  parseSlackTest,
  slackPayload,
  type Integrations,
  type SlackTestResult,
} from "./integrationModel";

type Operation = "save" | "disconnect" | "test";

export function useIntegrations() {
  const [config, setConfig] = useState<Integrations | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const version = useRef(0);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    const request = ++version.current;
    setLoading(true);
    try {
      const next = parseIntegrations(await api("/integrations"));
      if (mounted.current && request === version.current) {
        setConfig(next);
        setError("");
      }
    } catch (failure) {
      if (mounted.current && request === version.current) {
        setError(integrationError(failure, "load"));
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
      if (!resource || resource === "integrations") void load();
    };
    const focus = () => {
      void load();
    };
    window.addEventListener("tunaxa:resource-changed", refresh);
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      version.current++;
      window.removeEventListener("tunaxa:resource-changed", refresh);
      window.removeEventListener("focus", focus);
    };
  }, [load]);

  async function runOperation<T>(operation: Operation, task: () => Promise<T>): Promise<T> {
    if (busy.current) throw new Error("Wait for the current integration request");
    busy.current = true;
    version.current++;
    if (operation === "test") setTesting(true);
    else setSaving(true);
    try {
      const result = await task();
      if (mounted.current) setError("");
      return result;
    } catch (failure) {
      const message = integrationError(failure, operation);
      if (mounted.current) setError(message);
      throw new Error(message);
    } finally {
      busy.current = false;
      if (operation === "test") setTesting(false);
      else setSaving(false);
      if (mounted.current) void load();
    }
  }

  async function saveSlack(value: string) {
    const payload = slackPayload(value);
    return runOperation("save", async () => {
      const saved = assertSlackSaved(
        await api("/integrations/slack", json("PUT", payload)),
        payload,
      );
      if (mounted.current) setConfig(saved);
      return saved;
    });
  }

  async function disconnectSlack() {
    return runOperation("disconnect", async () => {
      const disconnected = assertSlackDisconnected(
        await api("/integrations/slack", json("DELETE")),
      );
      if (mounted.current) setConfig(disconnected);
      return disconnected;
    });
  }

  async function testSlack(): Promise<SlackTestResult> {
    return runOperation("test", async () =>
      parseSlackTest(await api("/integrations/slack/test", json("POST"))),
    );
  }

  return {
    config,
    loading,
    saving,
    testing,
    error,
    load,
    saveSlack,
    disconnectSlack,
    testSlack,
  };
}
