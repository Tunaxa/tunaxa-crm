import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, json, registerLogoutHandler, setToken } from "../lib/api";

type User = { id: string; name: string; email: string; role: string };

type Toast = {
  id: number;
  message: string;
  tone: "ok" | "error";
  duration: number;
};

type ContextValue = {
  user: User | null;
  setUser: (user: User | null) => void;
  toast: (message: string, tone?: "ok" | "error") => void;
  logout: () => Promise<void>;
};

const AppContext = createContext<ContextValue | null>(null);

const TOAST_DURATION = 3200;

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, tone: "ok" | "error" = "ok") => {
      const id = Date.now() + Math.random();

      setToasts((items) => [
        ...items,
        {
          id,
          message,
          tone,
          duration: TOAST_DURATION,
        },
      ]);

      window.setTimeout(() => {
        dismissToast(id);
      }, TOAST_DURATION);
    },
    [dismissToast],
  );

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", json("POST"));
    } catch (error) {
      console.warn("Logout request failed", error);
    }

    setToken("");
    setUser(null);

    if (window.location.hash !== "#/") {
      window.location.hash = "#/";
    }
  }, []);

  useEffect(() => registerLogoutHandler(logout), [logout]);

  const value = useMemo(
    () => ({ user, setUser, toast, logout }),
    [user, toast, logout],
  );

  return (
    <AppContext.Provider value={value}>
      {children}

      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((item) => (
          <div
            key={item.id}
            className={`app-toast ${item.tone}`}
            role={item.tone === "error" ? "alert" : "status"}
          >
            <div className="app-toast-content">
              <span>{item.message}</span>

              <button
                type="button"
                className="app-toast-dismiss"
                aria-label="Dismiss notification"
                onClick={() => dismissToast(item.id)}
              >
                ×
              </button>
            </div>

            <div
              className="app-toast-progress"
              style={{ animationDuration: `${item.duration}ms` }}
            />
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}

export function useApp() {
  const value = useContext(AppContext);

  if (!value) {
    throw new Error("AppProvider is missing");
  }

  return value;
}