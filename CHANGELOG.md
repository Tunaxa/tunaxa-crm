# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to Semantic Versioning.

## [Unreleased]

### Added

- New `ErrorBoundary` component (`web/src/components/ErrorBoundary.tsx`) wired into `web/src/App.tsx`: protects the whole route tree plus the Dashboard, Pipeline, and Contacts routes individually, each with its own fallback message.
- Added a `useSSE` React hook (`web/src/lib/useSSE.ts`) for live server-sent event updates from the backend, with automatic reconnect (exponential backoff: 1s, 2s, 4s, 8s, capped at 30s) and typed event callbacks. Wired into the app shell so pages like Dashboard and Leads refresh in real time when records change, instead of requiring a manual reload.

### Changed

- Per-route `ErrorBoundary` instances now get `key={location.pathname}`, so client-side navigation remounts a fresh boundary instead of carrying over a previously caught error's fallback UI.

### Fixed

- Backend failed to start locally: runtime data file `backend/data/db.json` was missing, so `app.listen(3001)` never ran; restored the tracked `db.json.bac` seed to `db.json`, unblocking `npm run server` and `npm start`. (Note: `db.json` is gitignored runtime data.)

### Security

- Added a scoped, short-lived (120s) query-token authentication path for the SSE endpoint only (`GET /api/events`), since browsers cannot attach custom headers to `EventSource` connections. Tokens are minted per-connection via a new authenticated endpoint (`POST /api/auth/events-token`), scoped to `purpose: "sse"`, and cannot be used on any other route. All other existing routes continue using standard header-based authentication, unchanged.

## [2.1.0] - 2026-09-16

### Added

- Initial CRM MVP: Express 5 backend (REST + GraphQL, JSON store, V1 PostgreSQL object API, workflows, webhooks, forms, surveys, reports, calls/recordings, AI, live chat, knowledge base, RBAC, file uploads, SSE) and React 18 + Vite frontend (dashboard, pipeline, all CRM modules, global search, quick-create, i18n EN/FR, dark mode), with tests and CI.

### Changed

- Standardized string quoting and improved logout error handling in `AppContext` (`d57414b`).
- Removed `--open` from Vite dev startup (`836239a`); updated Vite config in `package.json` and `web/vite.config.ts` (`4e9bc9b`).
- Added ESLint config and devDependencies (`fde1c02`, `fb9c4b4`); added `backend/data/db.json.bac` seed template (`f7890c0`).