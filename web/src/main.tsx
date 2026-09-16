import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import * as Sentry from "@sentry/react";
import App from "./App";
import "./i18n";
import "./styles/app.css";
import "./styles/blueprint.css";

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.2,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}

if (localStorage.getItem("tunaxa.theme") === "dark")
  document.documentElement.classList.add("dark");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary
      fallback={
        <div className="page">
          <section className="surface">
            <h2>Something went wrong</h2>
            <p>An unexpected error occurred. Reload the page to continue.</p>
          </section>
        </div>
      }
    >
      <HashRouter>
        <App />
      </HashRouter>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);
