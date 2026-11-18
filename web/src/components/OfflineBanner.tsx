import { useEffect, useState } from "react";

const RESOURCE_CHANGED_EVENT = "tunaxa:resource-changed";

function isBrowserOnline(): boolean {
  // Default to "online" when the API is unavailable so SSR and non-browser
  // test environments never render a false offline warning.
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(() => !isBrowserOnline());
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleOffline = () => {
      setIsChecking(false);
      setIsOffline(true);
    };

    const handleOnline = () => {
      setIsChecking(false);
      setIsOffline(false);
      window.dispatchEvent(new CustomEvent(RESOURCE_CHANGED_EVENT));
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  const retry = () => {
    if (!isBrowserOnline()) {
      setIsChecking(true);
      setIsOffline(true);
      return;
    }

    setIsChecking(false);
    setIsOffline(false);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(RESOURCE_CHANGED_EVENT));
    }
  };

  if (!isOffline) return null;

  return (
    <div
      className="offline-banner"
      role="region"
      aria-label="Connectivity status"
    >
      <span
        className="offline-banner__status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {isChecking
          ? "Still offline. Check your connection and try again."
          : "You are offline. Changes will retry when you reconnect."}
      </span>
      <button
        className="offline-banner__retry"
        type="button"
        onClick={retry}
      >
        Retry
      </button>
    </div>
  );
}
