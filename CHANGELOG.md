# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to Semantic Versioning.

## [Unreleased]

### Added

- **Workflow Execution Runs Migration (Migration 009):** Added `backend/db/migrations/009_workflow_runs.sql` creating the `workflow_runs` table with `TEXT` primary keys, `workspace_id` tenant isolation, `status` tracking (`running`, `success`, `failed`), `started_at`/`completed_at` timestamps, `steps JSONB`, `error_message`, and `update_updated_at_column()` triggers with 5 secondary indexes.
- **Workflow Runs Repository:** Implemented `backend/db/repositories/workflow-runs.js` providing `create`, `update`, `findById`, `findByWorkflowId`, and `findAll` with JSONB serialization (`toJsonb`) and workspace isolation. Registered in repository index under `workflowRuns` and `workflow_runs`.
- **Workflow Execution Tracking (`backend/services/workflows.js`):** Instrumented `triggerWorkflows()` to log run records on trigger and capture detailed per-node step execution metadata (`nodeId`, `nodeType`, `nodeName`, `status`, `output`, `error`, `executedAt`). Downstream nodes on inactive branches are explicitly recorded with `status: 'skipped'`.
- **Workflow Runs API (`backend/routes/workflowbuilder.js`):** Added `GET /api/workflows/:id/runs` endpoint with pagination and workspace isolation under `auth` and `requireRole('admin', 'member')`.
- **Workflow Runs Tests:** Added repository unit tests (`backend/db/repositories/__tests__/workflow-runs.test.js`) and end-to-end integration tests (`backend/__tests__/workflow-runs.test.js`) verifying graph step tracking, skipped condition branches, failure handling, 404 validation, and workspace isolation.
- **Workflow Node Graph Execution Engine (`backend/services/workflows.js`):**
  - Upgraded `triggerWorkflows()` to support visual node graph execution (`Trigger` → `Condition` → `Action`/`Delay`) in addition to legacy flat action lists.
  - Implemented graph adjacency traversal supporting edge schemas (`{ source, target, sourceHandle }` and `{ from, to, fromHandle }`) as well as direct node pointers (`node.next`, `trueNext`, `falseNext`).
  - Added condition branch evaluation (`evaluateCondition` and `evaluateOperator`) supporting direct properties, dot-notation nested paths, and `custom_fields` fallbacks.
  - Added support for comparison operators (`equals`, `not_equals`, `contains`, `greater_than`, `less_than`, `is_empty`, `is_not_empty`, `in`, `starts_with`, `ends_with`, `daysAgo`) and compound rule sets (`match: all | any`).
  - Implemented strict branch skipping: when a condition evaluates to `false`, non-matching branches are omitted from downstream execution unless connected to an explicit `false` handle.
  - Built-in cycle detection and recursion bounds (`MAX_STEPS = 200`) to guard against cyclic workflow graphs.
  - Integrated delayed actions and `delay` node scheduling via `scheduleExecution()`.
  - Updated `dryRunFlow()` to simulate node graph branch execution without state mutation.
- **Workflow Graph Unit Tests (`backend/services/__tests__/workflows-graph.test.js`):**
  - Added 19 comprehensive unit tests covering linear execution, conditional branching, false-branch skipping, compound condition logic, cycle prevention, delay scheduling, edge format compatibility, and legacy flat workflow fallback.
- **Marketing & Service Repositories:** Added repository modules for `campaigns`, `email-lists`, `forms`, `tickets`, `surveys`, and `survey-responses` under `backend/db/repositories/`.
- **Workspace Scoping on Repositories:** Extended `leads` and `contacts` repositories with optional `workspaceId` parameters on `findById` and `findByEmail` to prevent cross-tenant record tampering during public form submissions.
- **Queue Record Resolution:** Added `findRecord(resource, recordId)` in `backend/services/queue.js` to resolve workflow execution target records from PostgreSQL repositories or the legacy JSON store dynamically.
- **Marketing & Service Route Tests:** Added `backend/__tests__/marketing-service-routes.test.js` (40 tests) covering CRUD, ticket comments, SLA routes, form submissions, customer portal ticket visibility, and tenant isolation.
- **Revenue Route Integration Tests (`backend/__tests__/revenue-routes.test.js`):** Added 35 integration tests covering customer portal access resolution, category filtering, pagination clamping (`?limit=1000` clamped to 100), CSV exports for revenue resources, and 404 status assertions on non-existent IDs.
- **PostgreSQL Revenue Schema (Migration 006):** Created `backend/db/migrations/006_revenue_tables.sql` defining tables for `products`, `quotes`, `contracts`, `orders`, `invoices`, and `expenses`:
  - `TEXT` primary keys with `gen_random_uuid()::text` defaults for backwards compatibility and 404 handling.
  - `DOUBLE PRECISION` types for all monetary amounts, totals, costs, and prices to eliminate floating point / string coercion issues.
  - `items JSONB NOT NULL DEFAULT '[]'` for line items and `custom_fields JSONB NOT NULL DEFAULT '{}'` for overflow attributes.
  - `update_updated_at_column()` triggers on all 6 tables and 34 secondary indexes (40 total including the 6 primary keys) covering foreign keys, status, dates, and search columns.
- **Revenue Repositories:** Implemented repository modules under `backend/db/repositories/` (`products.js`, `quotes.js`, `contracts.js`, `orders.js`, `invoices.js`, `expenses.js`) with input validation, whitelisted sorting, and paginated query results.
- **Repository Registry Integration:** Registered all six revenue repositories in `backend/db/repositories/index.js` and `repoFor()`.
- **Data Migration Script:** Added `scripts/migrate-revenue-to-pg.js` for idempotent batch backfilling from `readDb()` into PostgreSQL. All six source arrays in `backend/data/db.json` are currently empty, so it currently migrates 0 rows; it is safe to re-run once data exists.
- **Unit & Integration Tests:** Added repository unit test suites under `backend/db/repositories/__tests__/` and updated test database truncation in `backend/__tests__/setup.js`.
- **PostgreSQL Marketing & Service Schema (Migration 007):** Created `backend/db/migrations/007_marketing_service_tables.sql` defining tables for `campaigns`, `email_lists`, `forms`, `tickets`, `surveys`, and `survey_responses` (numbered 007 because `006_revenue_tables.sql` already occupies 006 on this branch):
  - `TEXT` primary keys with `gen_random_uuid()::text` defaults, and `custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb` as the overflow bag.
  - `DOUBLE PRECISION` for monetary and counter columns (`campaigns.budget`/`spend`/`target`/`reached`/`leads`, `surveys.target_score`, `survey_responses.score`).
  - `update_updated_at_column()` trigger on all 6 tables and 28 secondary indexes (34 total including the 6 primary keys), including a `UNIQUE` index on `forms.permalink`, which `routes/forms.js` enforces and uses as its public lookup key.
  - Column names follow what the application actually writes rather than the obvious label, because several differ: `campaigns.channel` (not `type`), `tickets.stage` (not `status` — `routes/tickets.js` `slaStatus()` branches on it), `surveys.name` as `NOT NULL` (not `title`, which no code path writes), `email_lists.subscribers INTEGER` (the store holds a count, coerced by `helpers.js`, not an address array), and `tickets.contact`/`contact_email` (the legacy record stores a free-text contact name and has no contact id).
- **Marketing & Service Backfill Script:** Added `scripts/migrate-marketing-service-to-pg.js`, an idempotent batch upsert from `readDb()` that tolerates the `forms` and `tickets` keys being absent (both are created lazily by their route modules and are absent from `db.json`), accepts `email_lists`/`emailLists` and `survey_responses`/`surveyResponses` key aliases, JSON-serializes every JSONB parameter, mirrors each column's SQL default in a `DEFAULTS` map so an absent key lands on the default rather than an explicit `NULL` that would override it, and preserves historical `created_at`/`updated_at` on insert while excluding `created_at` from the update set. All six source arrays are currently empty, so it migrates 0 rows; it is safe to re-run once data exists.
- New database seed script (`backend/db/seed.js`, run via `npm run seed`) that populates the JSON store with realistic sample data — 20 contacts, 15 leads, 10 companies, 8 deals, 10 tasks, 5 activities, and an admin user (`admin@tunaxa.com` / `tunaxa2024`, role `admin`). Seeding is idempotent: re-running skips records that already exist instead of duplicating them.
- CSV downloads for leads, contacts, and companies, backed by the authenticated `/api/:resource/export.csv` endpoint.
- Goal progress bars and 50%, 75%, and 100% milestone badges on the Goals page, with red, amber, and green progress states.
- Activity timeline type filters for contact and company details, with server-side filtering for All, Emails, Calls, Meetings, Notes, and System events.
- New `ErrorBoundary` component (`web/src/components/ErrorBoundary.tsx`) wired into `web/src/App.tsx`: protects the whole route tree plus the Dashboard, Pipeline, and Contacts routes individually, each with its own fallback message.
- Fuzzy duplicate detection in `GET /api/duplicates` (`backend/routes/dataops.js`): near-match grouping at threshold 0.3 — exact keys short-circuit to 1.0; otherwise company names via `fuse.js` bitap and contact email local parts via length-normalized Levenshtein distance (`1 − lev(a,b) / max(len(a),len(b))`), so substring/prefix overlap like `alice` vs `alice.miller` no longer scores near-identical and local parts shorter than 4 characters never fuzzy-match. Each group's `matches[]` reports a per-member `score`/`rawScore` relative to the primary/kept record, which is what drives the UI (the group-level `score` is kept only as a display sort key), and `DuplicatesPage` shows a confidence badge on every duplicate row vs that primary — a "Philp Schmitz" primary with two "Phil Schmitz" members shows ~92% on each row — instead of one misleading group-level percentage.
- Webhook delivery hardening (inbound): `POST /api/hooks/:token` now logs fuller per-attempt delivery data (`contentType`, `remoteIp`, per-endpoint `attemptNumber`) to `db.webhookDeliveries`, and a new authenticated `GET /api/webhookEndpoints/:id/deliveries` returns that endpoint's recent deliveries (newest first, max 50).
- Inbound IMAP email sync worker polling every 5 minutes and linking matching contact activities.

### Changed

- **Test Database Setup (`backend/__tests__/setup.js`):** Included `workflow_runs` in the test database `TRUNCATE TABLE ... CASCADE;` cleanup routine.
- **Forms Route Cutover (`backend/routes/forms.js`):** Swapped permalink resolution and form submission handlers to use repositories; added workspace isolation to prevent cross-tenant overwrites; preserved custom fields during partial submissions; and wired activity creation into PostgreSQL.
- **Tickets Route Cutover (`backend/routes/tickets.js`):** Swapped ticket CRUD and comments to repositories; moved `PUT /api/tickets/sla` before parameterized `:id` routes to resolve route shadowing; and wired ticket activities to PostgreSQL.
- **Portal Ticket Resolution (`backend/routes/dataops.js`):** Updated `emailEquals` to check `contactEmail` so tickets are properly matched in `/api/portal/access`.
- **Execution Queue (`backend/routes/queue.js`):** Rewired delayed execution queuing to validate records against PostgreSQL repositories.
- **Customer Portal Data Access (`backend/routes/dataops.js`):** Generalized `loadDuplicateRows()` to `loadRows()`, allowing concurrent, repository-backed retrieval across `contacts`, `quotes`, `contracts`, and `invoices` via `Promise.all`. Preserved fallback to JSON store for `tickets`. Added `try/catch` block forwarding errors to `next(err)` to prevent unhandled promise rejections.
- **Resource Query Filtering (`backend/routes/resources.js`):** Added `"category"` to `PG_FILTER_KEYS` so `?category=` query parameters are properly routed to repository `findAll()` methods for `products` and `expenses`.
- **Portal Test Alignment (`backend/__tests__/extensions.test.js`):** Updated customer portal tests to seed entities via HTTP endpoints rather than mutating the legacy JSON store directly.
- **Shape Adapters (`backend/db/legacy-shape.js`):** Extended `PG_RESOURCES` (6 → 12 resources) and `RESOURCE_MAPPINGS` with bidirectional mappings, title fallback logic (`name`, `quote_number`/`contract_number`, `subject`, `customerEmail`), and numeric aliases (`amount` ↔ `total`).
- **Module Summaries (`backend/routes/modules.js`):** Updated `commerce/summary` and `finance/summary` to aggregate live revenue data from PostgreSQL repositories instead of reading stale JSON stores — they previously reported zero revenue once writes moved to Postgres.
- **JSONB Serialization Fix:** Ensured array fields (`items` / `lineItems`) are JSON-serialized before parameter binding to prevent PostgreSQL `22P02` array literal syntax errors. node-postgres sends a JS array as a Postgres array literal, which `jsonb` rejects; the same payload now round-trips correctly.
- **Custom Fields Coercion:** Extended `coerceBuiltIns()` in `backend/helpers.js` to recurse into `custom_fields`, so numeric overflow fields (`products.stock`, `products.minStock`, `contracts.mrr`) coerce to numbers instead of persisting as strings.
- AXA-154: Optimized the login background as WebP, self-hosted/preloaded Geist WOFF2 fonts, and deferred optional Sentry loading to reduce production preview render blocking and initial JavaScript.
- Per-route `ErrorBoundary` instances now get `key={location.pathname}`, so client-side navigation remounts a fresh boundary instead of carrying over a previously caught error's fallback UI.

### Fixed

- `scripts/migrate-revenue-to-pg.js` silently discarded every legacy timestamp: `created_at`/`updated_at` were computed in `main()` but never added to the `INSERT` column list, so every backfilled row received the column default `NOW()` instead of the record's real `createdAt`/`updatedAt`. Both columns are now inserted, and `created_at` is deliberately excluded from the `ON CONFLICT (id) DO UPDATE` assignment list so a re-run cannot restamp an original creation date. `updated_at` is left to the `update_updated_at_column()` trigger, which already overwrites it on every write. Found by a fixture pass on migration 007; the revenue backfill had never been run against non-empty data, so the bug was latent.
- Backend failed to start locally: runtime data file `backend/data/db.json` was missing, so `app.listen(3001)` never ran; restored the tracked `db.json.bac` seed to `db.json`, unblocking `npm run server` and `npm start`. (Note: `db.json` is gitignored runtime data.)
- `npm test` previously invoked `jest` (not installed); it now runs `vitest run`, matching the runner the backend suite actually uses (tests import from `vitest`, and `server.js` already skips `app.listen(3001)` when `VITEST === "true"`).
- Duplicate merge now happens atomically: `POST /api/duplicates/merge` accepts a `mergeIds` array and merges an entire duplicate group in a single `mutateDb()` call, and the Duplicates page sends all IDs in one request instead of looping per-merge HTTP calls, so a mid-merge failure can no longer leave partial/corrupted state.

### Testing

- AXA-154: Lighthouse on the production preview with the local API running improved the login screen from 86/95/100 to 98/95/100 (Performance/Accessibility/Best Practices); `npm run build`, TypeScript type-check, and targeted ESLint checks passed.
- Webhook delivery logging (inbound) — verified by the webhook-Endpoints vitest suite (`backend/__tests__/forms-webhooks.test.js`, 18/18 passing in isolation) and manually via the API: `npm run server`, authenticate (`POST /api/auth/login`, or reuse a live session token from `backend/data/db.json`), `POST /api/webhookEndpoints` with `{"name":"Manual test","enabled":true}` and note the returned `id`/`url`, then `POST <url>` with `Content-Type: application/json` (repeat 3×) and `GET /api/webhookEndpoints/:id/deliveries` with `Authorization: Bearer $TOKEN` → newest-first rows with `status:"received"`, captured `contentType`/`remoteIp`, and per-endpoint `attemptNumber` incrementing 1→2→3…; same GET without a token → 401, bogus endpoint id with a token → 404.

## [2.1.0] - 2026-09-16

### Added

- Initial CRM MVP: Express 5 backend (REST + GraphQL, JSON store, V1 PostgreSQL object API, workflows, webhooks, forms, surveys, reports, calls/recordings, AI, live chat, knowledge base, RBAC, file uploads, SSE) and React 18 + Vite frontend (dashboard, pipeline, all CRM modules, global search, quick-create, i18n EN/FR, dark mode), with tests and CI.

### Changed

- Standardized string quoting and improved logout error handling in `AppContext` (`d57414b`).
- Removed `--open` from Vite dev startup (`836239a`); updated Vite config in `package.json` and `web/vite.config.ts` (`4e9bc9b`).
- Added ESLint config and devDependencies (`fde1c02`, `fb9c4b4`); added `backend/data/db.json.bac` seed template (`f7890c0`).
