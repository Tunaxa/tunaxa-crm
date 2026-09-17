import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, json, setToken } from "../lib/api";
import { Icon } from "../components/Icon";

type User = { id: string; name: string; email: string; role: string };
type ToastTone = "ok" | "error" | "warning";
const toneIcon: Record<ToastTone, string> = {
  ok: "checkCircle",
  error: "alertCircle",
  warning: "warning",
};
type Toast = { id: number; message: string; tone: ToastTone; timer: number };
type ContextValue = {
  user: User | null;
  setUser: (user: User | null) => void;
  toast: (message: string, tone?: ToastTone) => void;
  logout: () => Promise<void>;
};

const AppContext = createContext<ContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  function toast(message: string, tone: ToastTone = "ok") {
    const id = Date.now() + Math.random();
    const timer = window.setTimeout(() => dismiss(id), 3200);
    setToasts((items) => [...items, { id, message, tone, timer }]);
  }

  function dismiss(id: number) {
    setToasts((items) => {
      const target = items.find((item) => item.id === id);
      if (target) window.clearTimeout(target.timer);
      return items.filter((item) => item.id !== id);
    });
  }

  async function logout() {
    try {
      await api("/auth/logout", json("POST"));
    } catch (error) {
      console.warn("Logout request failed", error);
    }
    setToken("");
    setUser(null);
  }

  const value = useMemo(() => ({ user, setUser, toast, logout }), [user]);
  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="toast-stack">
        {toasts.map((item) => (
          <div
            key={item.id}
            className={`app-toast ${item.tone}`}
            role={item.tone === "error" ? "alert" : "status"}
            onClick={() => dismiss(item.id)}
          >
            <span className="app-toast-icon">
              <Icon name={toneIcon[item.tone]} />
            </span>
            <span className="app-toast-message">{item.message}</span>
            <button
              type="button"
              className="app-toast-close"
              aria-label="Dismiss notification"
              onClick={(event) => {
                event.stopPropagation();
                dismiss(item.id);
              }}
            >
              <Icon name="close" size={14} />
            </button>
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
