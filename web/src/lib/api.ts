const base = "/api";

export type ApiError = Error & { status?: number };
type LogoutHandler = () => Promise<void> | void;

let logoutHandler: LogoutHandler | null = null;
let refreshRequest: Promise<string | null> | null = null;
let handlingAuthFailure = false;
const MAX_REQUEST_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 2500;

export function registerLogoutHandler(handler: LogoutHandler) {
  logoutHandler = handler;
  return () => {
    if (logoutHandler === handler) logoutHandler = null;
  };
}

export function getToken() {
  return localStorage.getItem("tunaxa.token") || "";
}

export function setToken(token: string) {
  if (token) localStorage.setItem("tunaxa.token", token);
  else localStorage.removeItem("tunaxa.token");
}

async function refreshToken() {
  if (!refreshRequest) {
    refreshRequest = fetch(`${base}/auth/refresh`, {
      method: "POST",
      headers: getToken()
        ? { Authorization: `Bearer ${getToken()}` }
        : undefined,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || typeof body.token !== "string") return null;
        setToken(body.token);
        return body.token;
      })
      .catch(() => null)
      .finally(() => {
        refreshRequest = null;
      });
  }
  return refreshRequest;
}

async function notifyAuthFailure() {
  if (handlingAuthFailure || !logoutHandler) return;
  handlingAuthFailure = true;
  try {
    await logoutHandler();
  } finally {
    handlingAuthFailure = false;
  }
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelay(attempt: number, response?: Response) {
  const retryAfter = response?.headers.get("Retry-After");
  const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : NaN;
  if (Number.isFinite(retryAfterMs)) return Math.max(0, retryAfterMs);
  return Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** attempt,
  ) + Math.random() * RETRY_BASE_DELAY_MS;
}

async function waitForRetry(attempt: number, response?: Response) {
  await new Promise((resolve) =>
    setTimeout(resolve, retryDelay(attempt, response)),
  );
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const request = async () => {
    const headers = new Headers(options.headers || {});
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (options.body && !(options.body instanceof FormData))
      headers.set("Content-Type", "application/json");
    return fetch(`${base}${path}`, { ...options, headers });
  };

  const requestWithRetry = async () => {
    const method = String(options.method || "GET").toUpperCase();
    const retryEnabled =
      method === "GET" ||
      method === "HEAD" ||
      method === "OPTIONS" ||
      new Headers(options.headers || {}).has("Idempotency-Key");

    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
      try {
        const response = await request();
        if (
          !retryEnabled ||
          !isRetryableStatus(response.status) ||
          attempt === MAX_REQUEST_ATTEMPTS - 1
        )
          return response;
        await waitForRetry(attempt, response);
      } catch (error) {
        if (!retryEnabled || attempt === MAX_REQUEST_ATTEMPTS - 1) throw error;
        await waitForRetry(attempt);
      }
    }
    throw new Error("Request retry limit exceeded");
  };

  let response = await requestWithRetry();
  let body = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/auth/refresh") {
    const token = await refreshToken();
    if (token) {
      response = await requestWithRetry();
      body = await response.json().catch(() => ({}));
      if (response.ok) return body as T;
      if (response.status !== 401) {
        const error = new Error(
          body.error || `Request failed (${response.status})`,
        ) as ApiError;
        error.status = response.status;
        throw error;
      }
    }
    await notifyAuthFailure();
  }
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
