const base = "/api";

export type ApiError = Error & { status?: number };

export function getToken() {
  return localStorage.getItem("tunaxa.token") || "";
}

export function setToken(token: string) {
  if (token) localStorage.setItem("tunaxa.token", token);
  else localStorage.removeItem("tunaxa.token");
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      body.error || `Request failed (${response.status})`,
    ) as ApiError;
    error.status = response.status;
    throw error;
  }
  return body as T;
}

export const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});
