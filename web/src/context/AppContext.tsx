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
type Toast = { id: number; message: string; tone: "ok" | "error" };
type ContextValue = {
  user: User | null;
  setUser: (user: User | null) => void;
  toast: (message: string, tone?: "ok" | "error") => void;
  logout: () => Promise<void>;
};

const AppContext = createContext<ContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  function toast(message: string, tone: "ok" | "error" = "ok") {
    const id = Date.now() + Math.random();
    setToasts((items) => [...items, { id, message, tone }]);
    window.setTimeout(
      () => setToasts((items) => items.filter((item) => item.id !== id)),
      3200,
    );
  }

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", json("POST"));
    } catch (error) {
      console.warn("Logout request failed", error);
    }
    setToken("");
    setUser(null);
    if (window.location.hash !== "#/") window.location.hash = "#/";
  }, []);

  useEffect(() => registerLogoutHandler(logout), [logout]);

  const value = useMemo(() => ({ user, setUser, toast, logout }), [user, logout]);
  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="toast-stack">
        {toasts.map((item) => (
          <div key={item.id} className={`app-toast ${item.tone}`}>
            {item.message}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("AppProvider is missing");
  return value;
}
