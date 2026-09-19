# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to Semantic Versioning.

## [Unreleased]

### Added

- New `ErrorBoundary` component (`web/src/components/ErrorBoundary.tsx`) wired into `web/src/App.tsx`: protects the whole route tree plus the Dashboard, Pipeline, and Contacts routes individually, each with its own fallback message.
- Fuzzy duplicate detection in `GET /api/duplicates` (`backend/routes/dataops.js`): near-match grouping at threshold 0.3 — exact keys short-circuit to 1.0; otherwise company names via `fuse.js` bitap and contact email local parts via length-normalized Levenshtein distance (`1 − lev(a,b) / max(len(a),len(b))`), so substring/prefix overlap like `alice` vs `alice.miller` no longer scores near-identical and local parts shorter than 4 characters never fuzzy-match. Each group's `matches[]` reports a per-member `score`/`rawScore` relative to the primary/kept record, which is what drives the UI (the group-level `score` is kept only as a display sort key), and `DuplicatesPage` shows a confidence badge on every duplicate row vs that primary — a "Philp Schmitz" primary with two "Phil Schmitz" members shows ~92% on each row — instead of one misleading group-level percentage.

### Changed

- Per-route `ErrorBoundary` instances now get `key={location.pathname}`, so client-side navigation remounts a fresh boundary instead of carrying over a previously caught error's fallback UI.

### Fixed

- Backend failed to start locally: runtime data file `backend/data/db.json` was missing, so `app.listen(3001)` never ran; restored the tracked `db.json.bac` seed to `db.json`, unblocking `npm run server` and `npm start`. (Note: `db.json` is gitignored runtime data.)

## [2.1.0] - 2026-09-16

### Added

- Initial CRM MVP: Express 5 backend (REST + GraphQL, JSON store, V1 PostgreSQL object API, workflows, webhooks, forms, surveys, reports, calls/recordings, AI, live chat, knowledge base, RBAC, file uploads, SSE) and React 18 + Vite frontend (dashboard, pipeline, all CRM modules, global search, quick-create, i18n EN/FR, dark mode), with tests and CI.

### Changed

- Standardized string quoting and improved logout error handling in `AppContext` (`d57414b`).
- Removed `--open` from Vite dev startup (`836239a`); updated Vite config in `package.json` and `web/vite.config.ts` (`4e9bc9b`).
- Added ESLint config and devDependencies (`fde1c02`, `fb9c4b4`); added `backend/data/db.json.bac` seed template (`f7890c0`).