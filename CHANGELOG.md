# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to Semantic Versioning.

## [Unreleased]

### Added

- PostgreSQL migration runner (`npm run migrate`) that records applied SQL files in `schema_migrations` and applies pending migrations in filename order.
- Pipeline: added total and weighted pipeline value summary
- A four-step custom report builder for Deals, Contacts, and Leads with metric, group-by, and date-range controls, plus normalized table and bar-chart results from `POST /api/reports/query`.
- Email-based team invitations with a sent confirmation, pending invitation list, expiry display, retry state, and resend action. The frontend uses `POST /api/users/invite` and `GET /api/users/invites` without directly creating user accounts.
- Secure email-based team invitations (backend): admins can `POST /api/users/invite` to generate a one-time, 48-hour invite token that is emailed as an accept link (`{publicBaseUrl}/accept-invite?token=…`), and invitees complete the public `POST /api/auth/accept-invite` endpoint with the token, name, and password to have their `member` account provisioned and a session created. Expired, unknown, or already-used tokens are rejected with a 400, and re-inviting an email invalidates any previously pending invite.
- A first-login onboarding gate for empty workspaces with a resumable four-step wizard for company profile, contact CSV import, pipeline stages, and team invitations. Progress and completion are stored per user, and every step or the full setup can be skipped.
- Added a reusable electronic-signature modal with draw and typed-name modes, live typed preview, explicit consent, PNG/SVG output, validation, and accessible controls.
- Replaced the Goals table with a responsive progress-card dashboard, added an inline quick-add form, and added reduced-motion-aware confetti when a goal newly reaches 50%, 75%, or 100%.
- Replaced the quote line-item text area with a dynamic quote builder that supports adding and removing products, quantity and unit-price inputs, live line totals, subtotal, discount, tax, and grand-total calculations.
- New database seed script (`backend/db/seed.js`, run via `npm run seed`) that populates the JSON store with realistic sample data — 20 contacts, 15 leads, 10 companies, 8 deals, 10 tasks, 5 activities, and an admin user (`admin@tunaxa.com` / `tunaxa2024`, role `admin`). Seeding is idempotent: re-running skips records that already exist instead of duplicating them.
- CSV downloads for leads, contacts, and companies, backed by the authenticated `/api/:resource/export.csv` endpoint.
- Goal progress bars and 50%, 75%, and 100% milestone badges on the Goals page, with red, amber, and green progress states.
- Activity timeline type filters for contact and company details, with server-side filtering for All, Emails, Calls, Meetings, Notes, and System events.
- New `ErrorBoundary` component (`web/src/components/ErrorBoundary.tsx`) wired into `web/src/App.tsx`: protects the whole route tree plus the Dashboard, Pipeline, and Contacts routes individually, each with its own fallback message.
- Fuzzy duplicate detection in `GET /api/duplicates` (`backend/routes/dataops.js`): near-match grouping at threshold 0.3 — exact keys short-circuit to 1.0; otherwise company names via `fuse.js` bitap and contact email local parts via length-normalized Levenshtein distance (`1 − lev(a,b) / max(len(a),len(b))`), so substring/prefix overlap like `alice` vs `alice.miller` no longer scores near-identical and local parts shorter than 4 characters never fuzzy-match. Each group's `matches[]` reports a per-member `score`/`rawScore` relative to the primary/kept record, which is what drives the UI (the group-level `score` is kept only as a display sort key), and `DuplicatesPage` shows a confidence badge on every duplicate row vs that primary — a "Philp Schmitz" primary with two "Phil Schmitz" members shows ~92% on each row — instead of one misleading group-level percentage.
- Webhook delivery hardening (inbound): `POST /api/hooks/:token` now logs fuller per-attempt delivery data (`contentType`, `remoteIp`, per-endpoint `attemptNumber`) to `db.webhookDeliveries`, and a new authenticated `GET /api/webhookEndpoints/:id/deliveries` returns that endpoint's recent deliveries (newest first, max 50).
- Workflow builder API now accepts and persists complete `nodes` and `edges` graph JSON through POST, PUT, and GET workflow endpoints, with validation for malformed graph payloads.
- Inbound IMAP email sync worker polling every 5 minutes and linking matching contact activities.
- Added a `useSSE` React hook (`web/src/lib/useSSE.ts`) for live server-sent event updates from the backend, with automatic reconnect (exponential backoff: 1s, 2s, 4s, 8s, capped at 30s) and typed event callbacks. Wired into the app shell so pages like Dashboard and Leads refresh in real time when records change, instead of requiring a manual reload.
- JSON to PostgreSQL idempotent data migration script (scripts/migrate-json-to-pg.js and npm run migrate:data).
- Core relational PostgreSQL schema migration (004_core_relational_tables.sql) with workspace foreign keys and auto-update triggers.
- Inbound IMAP email sync worker polling every 5 minutes and linking matching contact activities.
- PostgreSQL repository layer for Companies, Deals, Tasks, and Activities with CRUD, pagination, search, sorting whitelists, and pipeline aggregation.
- Parameterized PostgreSQL repository layer for Contacts and Leads with CRUD, pagination, search, and validated sorting.
- PostgreSQL repository layer for Companies, Deals, Tasks, and Activities with CRUD, pagination, search, sorting whitelists, and pipeline aggregation.
- Redis query caching with 60s TTL and pattern-based invalidation across core repository findAll queries.

### Changed

- Optimized the login background as WebP, self-hosted/preloaded Geist WOFF2 fonts, and deferred optional Sentry loading to reduce production preview render blocking and initial JavaScript.
- Per-route `ErrorBoundary` instances now get `key={location.pathname}`, so client-side navigation remounts a fresh boundary instead of carrying over a previously caught error's fallback UI.

### Fixed

- Rate-limit buckets now use Redis `INCR`/`EXPIRE` when Redis is connected, with the existing in-memory fallback retained when it is unavailable.
- Added `POST /api/auth/refresh` with 30-day session token rotation, invalidating the previous token after each successful refresh.
- Added Helmet security headers, including `X-Frame-Options: DENY`, a permissive Content Security Policy, and Strict-Transport-Security.
- Secured Server-Sent Events by requiring authentication and restricting event delivery to the authenticated user's workspace.
- Search: updated empty search result message
- Login: lower Sign In button spacing next to Remember me
- Cleared critical and serious accessibility findings by naming icon-only buttons and form controls, raising muted text to WCAG AA contrast in light and dark themes, and enforcing a visible keyboard focus ring across interactive elements.
- Backend failed to start locally: runtime data file `backend/data/db.json` was missing, so `app.listen(3001)` never ran; restored the tracked `db.json.bac` seed to `db.json`, unblocking `npm run server` and `npm start`. (Note: `db.json` is gitignored runtime data.)
- `npm test` previously invoked `jest` (not installed); it now runs `vitest run`, matching the runner the backend suite actually uses (tests import from `vitest`, and `server.js` already skips `app.listen(3001)` when `VITEST === "true"`).
- Duplicate merge now happens atomically: `POST /api/duplicates/merge` accepts a `mergeIds` array and merges an entire duplicate group in a single `mutateDb()` call, and the Duplicates page sends all IDs in one request instead of looping per-merge HTTP calls, so a mid-merge failure can no longer leave partial/corrupted state.

### Testing

- Automated axe-core audit of the login screen, all 41 main authenticated routes, and four representative dark-mode routes completed 46 scans with zero critical or serious violations; production build, TypeScript type-check, targeted ESLint, and static JSX accessibility checks also passed.
- Lighthouse on the production preview with the local API running improved the login screen from 86/95/100 to 98/95/100 (Performance/Accessibility/Best Practices); `npm run build`, TypeScript type-check, and targeted ESLint checks passed.
- Production build, TypeScript type-check, targeted ESLint, and report query/result normalization tests pass (3/3).
- Lighthouse on the production preview with the local API running improved the login screen from 86/95/100 to 98/95/100 (Performance/Accessibility/Best Practices); `npm run build`, TypeScript type-check, and targeted ESLint checks passed.
- Production build, TypeScript type-check, targeted ESLint, and invitation response/expiry tests pass (3/3).
- Lighthouse on the production preview with the local API running improved the login screen from 86/95/100 to 98/95/100 (Performance/Accessibility/Best Practices); `npm run build`, TypeScript type-check, and targeted ESLint checks passed.
- Production build, TypeScript type-check, targeted ESLint, and onboarding preference tests pass (3/3).
- Lighthouse on the production preview with the local API running improved the login screen from 86/95/100 to 98/95/100 (Performance/Accessibility/Best Practices); `npm run build`, TypeScript type-check, and targeted ESLint checks passed.
- Added focused tests for draw/type readiness, required consent, typed-signature data URLs, and XML escaping; production build and targeted lint/type checks pass.
- Lighthouse on the production preview with the local API running improved the login screen from 86/95/100 to 98/95/100 (Performance/Accessibility/Best Practices); `npm run build`, TypeScript type-check, and targeted ESLint checks passed.
- Added focused tests for progress colors, capped progress-bar width, and newly crossed milestone detection; production build and targeted lint/type checks pass.
- Added focused unit coverage for line totals, discount-before-tax calculations, percentage limits, negative values, rounding, and legacy item normalization; production build and targeted lint/type checks pass.
- Lighthouse on the production preview with the local API running improved the login screen from 86/95/100 to 98/95/100 (Performance/Accessibility/Best Practices); `npm run build`, TypeScript type-check, and targeted ESLint checks passed.
- Webhook delivery logging (inbound) — verified by the webhook-Endpoints vitest suite (`backend/__tests__/forms-webhooks.test.js`, 18/18 passing in isolation) and manually via the API: `npm run server`, authenticate (`POST /api/auth/login`, or reuse a live session token from `backend/data/db.json`), `POST /api/webhookEndpoints` with `{"name":"Manual test","enabled":true}` and note the returned `id`/`url`, then `POST <url>` with `Content-Type: application/json` (repeat 3×) and `GET /api/webhookEndpoints/:id/deliveries` with `Authorization: Bearer $TOKEN` → newest-first rows with `status:"received"`, captured `contentType`/`remoteIp`, and per-endpoint `attemptNumber` incrementing 1→2→3…; same GET without a token → 401, bogus endpoint id with a token → 404.

### Security

- Added a scoped, short-lived (120s) query-token authentication path for the SSE endpoint only (`GET /api/events`), since browsers cannot attach custom headers to `EventSource` connections. Tokens are minted per-connection via a new authenticated endpoint (`POST /api/auth/events-token`), scoped to `purpose: "sse"`, and cannot be used on any other route. All other existing routes continue using standard header-based authentication, unchanged.

## [2.1.0] - 2026-09-16

### Added

- Initial CRM MVP: Express 5 backend (REST + GraphQL, JSON store, V1 PostgreSQL object API, workflows, webhooks, forms, surveys, reports, calls/recordings, AI, live chat, knowledge base, RBAC, file uploads, SSE) and React 18 + Vite frontend (dashboard, pipeline, all CRM modules, global search, quick-create, i18n EN/FR, dark mode), with tests and CI.

### Changed

- Standardized string quoting and improved logout error handling in `AppContext` (`d57414b`).
- Removed `--open` from Vite dev startup (`836239a`); updated Vite config in `package.json` and `web/vite.config.ts` (`4e9bc9b`).
- Added ESLint config and devDependencies (`fde1c02`, `fb9c4b4`); added `backend/data/db.json.bac` seed template (`f7890c0`).
