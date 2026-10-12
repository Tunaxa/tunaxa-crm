import { useEffect, useState } from "react";

export default function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const handleOffline = () => setIsOffline(true);

    const handleOnline = () => {
      setIsOffline(false);
      window.dispatchEvent(
        new CustomEvent("tunaxa:resource-changed"),
      );
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  const retry = () => {
    if (!navigator.onLine) return;

    setIsOffline(false);
    window.dispatchEvent(
      new CustomEvent("tunaxa:resource-changed"),
    );
  };

  if (!isOffline) return null;

  return (
    <div
      role="status"
      className="fixed top-0 left-0 right-0 z-[9999] flex items-center justify-center gap-3 bg-red-600 px-4 py-2 text-sm font-medium text-white"
    >
      <span>
        You are offline. Changes will retry when you reconnect.
      </span>
      <button
        type="button"
        onClick={retry}
        className="rounded border border-white/40 px-2 py-1 hover:bg-white/10"
      >
        Retry
      </button>
    </div>
  );
}
