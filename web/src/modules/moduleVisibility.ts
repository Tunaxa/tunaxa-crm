import { createElement, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useApp } from "../context/AppContext";
import { api, getToken } from "../lib/api";

const ROLE_RANK: Readonly<Record<string, number>> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 2,
};

export const MODULE_CATALOG: Readonly<Record<string, string>> = Object.freeze({
  "/": "viewer",
  "/dashboard": "viewer",
  "/contacts": "viewer",
  "/companies": "viewer",
  "/deals": "viewer",
  "/leads": "member",
  "/tickets": "viewer",
  "/sequences": "viewer",
  "/import": "member",
  "/integrations": "admin",
  "/team": "admin",
  "/settings": "admin",
});

const PATH_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "/": ["/", "/dashboard"],
  "/dashboard": ["/", "/dashboard"],
});

export type ModuleInfo = {
  id?: unknown;
  path?: unknown;
  minRole?: unknown;
};

export function normalizeRole(role: unknown): string {
  if (typeof role !== "string") return "viewer";
  const key = role.trim().toLowerCase();
  return key in ROLE_RANK ? key : "viewer";
}

export function roleRank(role: unknown): number {
  return ROLE_RANK[normalizeRole(role)] ?? 0;
}

export function normalizeModulePath(value: unknown): string {
  if (typeof value !== "string") return "/";
  const withoutQuery = value.split(/[?#]/, 1)[0].trim();
  if (!withoutQuery) return "/";
  const withSlash = withoutQuery.startsWith("/")
    ? withoutQuery
    : `/${withoutQuery}`;
  const collapsed = withSlash.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return collapsed || "/";
}

export function modulePathFromHash(hash: unknown, fallback = "/"): string {
  if (typeof hash === "string" && hash.startsWith("#")) {
    return normalizeModulePath(hash.slice(1));
  }
  return normalizeModulePath(fallback);
}

export function moduleBasePath(pathname: unknown): string {
  const path = normalizeModulePath(pathname);
  const segments = path.split("/").filter(Boolean);
  if (segments.length > 1) return `/${segments[0]}`;
  return path;
}

export function modulePathsFromPayload(payload: unknown): Set<string> | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const raw = Array.isArray(root.modules)
    ? root.modules
    : Array.isArray(payload)
      ? payload
      : null;
  if (!raw) return null;
  const paths = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const path = normalizeModulePath((item as ModuleInfo).path);
    if (path) paths.add(path);
  }
  return paths;
}

export function allowedByRole(pathname: unknown, role: unknown): boolean {
  const path = moduleBasePath(pathname);
  const minRole = MODULE_CATALOG[path];
  if (!minRole) return true;
  return roleRank(role) >= roleRank(minRole);
}

export function isModuleVisible(
  pathname: unknown,
  modulePaths: ReadonlySet<string> | null,
  role: unknown,
): boolean {
  const path = moduleBasePath(pathname);
  const minRole = MODULE_CATALOG[path];
  if (!minRole) return true;
  if (!allowedByRole(path, role)) return false;
  if (!modulePaths) return true;
  const aliases = PATH_ALIASES[path] ?? [path];
  return aliases.some((candidate) => modulePaths.has(candidate));
}

export function useModuleVisibility() {
  const { user } = useApp();
  const [modulePaths, setModulePaths] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(() => Boolean(getToken()));

  useEffect(() => {
    let active = true;
    if (!getToken()) {
      setModulePaths(null);
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    api<{ modules?: unknown }>("/modules")
      .then((payload) => {
        if (!active) return;
        setModulePaths(modulePathsFromPayload(payload));
      })
      .catch(() => {
        if (!active) return;
        setModulePaths(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user?.id, user?.role]);

  return {
    role: user?.role ?? "",
    loading,
    modulePaths,
    canView: (pathname: unknown) =>
      isModuleVisible(pathname, modulePaths, user?.role),
  };
}

function currentPath(routerPath: string): string {
  if (typeof window !== "undefined") {
    const hash = (window as { location?: { hash?: string } }).location?.hash;
    if (typeof hash === "string" && hash.startsWith("#/")) {
      return modulePathFromHash(hash, routerPath);
    }
  }
  return normalizeModulePath(routerPath);
}

export function ModuleGate({
  children,
  path,
  fallback,
  loadingFallback,
}: {
  children: ReactNode;
  path?: string;
  fallback?: ReactNode;
  loadingFallback?: ReactNode;
}) {
  const location = useLocation();
  const { canView, loading, role } = useModuleVisibility();
  const target = path ?? currentPath(location.pathname);

  if (loading) {
    return loadingFallback
      ? createElement("div", { key: "module-loading" }, loadingFallback)
      : createElement(
          "main",
          { className: "page", role: "status" },
          createElement("div", { className: "table-loading" }, "Checking module access…"),
        );
  }

  if (canView(target)) return createElement("div", { key: "module-content" }, children);

  if (fallback) return createElement("div", { key: "module-denied" }, fallback);

  return createElement(
    "main",
    { className: "page module-gate-denied", role: "alert" },
    createElement("h1", null, "Access restricted"),
    createElement(
      "p",
      null,
      `Your role (${normalizeRole(role)}) cannot open this module. Contact an administrator if you need access.`,
    ),
    createElement("p", null, createElement("a", { href: "#/dashboard" }, "Return to dashboard")),
  );
}
