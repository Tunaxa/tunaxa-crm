import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./i18n";
import "./styles/fonts.css";
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

const root = ReactDOM.createRoot(document.getElementById("root")!);
const app = (
  <HashRouter>
    <App />
  </HashRouter>
);

function renderWithoutSentry() {
  root.render(
    <React.StrictMode>
      <ErrorBoundary fallbackMessage="An unexpected error occurred. Reload the page to continue.">
        {app}
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

if (import.meta.env.VITE_SENTRY_DSN) {
  void import("@sentry/react")
    .then((Sentry) => {
      Sentry.init({
        dsn: import.meta.env.VITE_SENTRY_DSN,
        environment: import.meta.env.MODE,
        tracesSampleRate: 0.2,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
      });
      root.render(
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
            {app}
          </Sentry.ErrorBoundary>
        </React.StrictMode>,
      );
    })
    .catch((error) => {
      console.error("Sentry failed to load:", error);
      renderWithoutSentry();
    });
} else {
  renderWithoutSentry();
}
