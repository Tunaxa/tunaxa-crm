# Sequence UI

AXA-316 adds an ordered email cadence builder at `/sequences` and an enrollment picker on contact record pages. The previous generic form submitted a text description for `steps`, which the sequence API rejects because it requires an array.

## Delivery dependencies

- Branch: `feat/sequence-builder`; PR base: `dev`.
- Frontend predecessor: [#475](https://github.com/Tunaxa/tunaxa-crm/pull/475), which extracts the shared record detail component. This branch excludes the CSV, ticket and multi-pipeline feature commits.
- Contact enrollment requires backend [#470](https://github.com/Tunaxa/tunaxa-crm/pull/470). Its contract was inspected at head `8977c43f96ebd3daad4bceb4c3bce3477673db4f`. That backend PR itself has chained predecessors; its owner must manage their merge order.
- No production backend files, schemas or migrations are changed by this feature. The backend file added here is an integration test.

## Contracts

The builder uses existing `GET /api/sequences`, `GET /api/sequences/:id`, `POST /api/sequences` and `PUT /api/sequences/:id`. Saves send `{ name, enabled, steps }`. Each email step has a stable server ID when editing, an order, subject, body and numeric `delayDays`, `delayHours` and `delayMinutes`. Existing recipient overrides and extra step fields are preserved. A save is confirmed against the returned data before showing success.

Enrollment uses the first-class model in #470:

- `GET /api/sequences/:id/enrollments?page=N&limit=50` returns `{ data, total, page, pageSize }`.
- `POST /api/sequences/:id/enroll` sends `{ contactIds: [contactId] }`.
- The response is `{ enrolled, skipped, enrollments }`; returned IDs/contact/sequence/status must confirm the requested enrollment.
- Statuses are `active`, `paused`, `replied`, `completed` and `stopped`. Active or paused enrollments block duplicates. A user may explicitly enroll again after a terminal status.

All enrollment pages are read before checking for duplicates. Missing, repeated or inconsistent pages block the action. A 404 shows an availability message; the UI does not silently switch to the legacy `recordIds` enrollment model. Sequence configuration and enrollment status are fetched again immediately before enrollment. Changed configurations require another review. Uncertain writes require a status refresh before another attempt.

## Supported behavior and limits

The email builder supports email actions (`email` and `sendEmail`). Existing legacy descriptions and non-email actions remain visible and cannot be overwritten through this editor. It validates names, subjects, message bodies and finite schedulable delays, and supports adding, removing and reordering steps.

Admin/member users can build, edit, change availability, delete and enroll. Viewers retain read-only sequence access. Step editing/deletion checks both legacy nested enrollments and first-class enrollment records, blocking active or paused cadences. Existing editing checks also detect a changed `updatedAt` before saving. These preflight checks are not an atomic server-side lock against concurrent requests.

Availability controls new enrollment from this UI. Disabling it does not claim to pause contacts already enrolled. Automatic execution, provider delivery and inbound-reply processing remain the responsibility of the backend cadence runner, email service and IMAP integration. No run or email send operation is triggered while building a cadence or by the verification harness.

## Verification

- Full branch suite: 71 files / 1,003 tests passed with a fresh isolated PostgreSQL database and existing migrations.
- Focused checks cover payloads, delays, stable IDs/metadata, malformed responses, pagination, duplicate and unavailable-API handling, role restrictions and server-rendered UI.
- The permanent API integration test saves, reloads and reorders three steps against the existing backend, preserving IDs and exit rules.
- A temporary isolated harness passed two compatibility checks against the exact pending #470 route, enrollment service and permission helpers. It verified three-step creation/enrollment, duplicate prevention, pause/resume and reply status handling. This does not confirm that #470 is merged or deployed, nor does it test email delivery or the real IMAP hook.
- TypeScript and repository ESLint passed. Local production build remains blocked by esbuild `spawn EPERM`; tests used a temporary native TypeScript transform. Browser interaction is still pending.

## Browser acceptance after backend merge

1. Build a three-step cadence with delays of 0, 2 and 5 days. Set it available for enrollment. Save, reload and verify order, subjects, bodies and delays.
2. Edit an unenrolled cadence: add/remove/reorder steps; save and verify stable IDs and preserved configuration.
3. Open a contact with a valid email, select the cadence, review its steps and enroll. Refresh status and confirm the active enrollment appears.
4. Try enrolling that contact again and verify it is blocked. Check paused and terminal enrollment statuses.
5. Attempt to edit/delete a cadence with ongoing enrollments. Verify it is blocked. Disabling new enrollment must not be presented as pausing existing contacts.
6. Check viewer access, invalid fields, failed requests/retry, missing enrollment API, narrow screens, keyboard focus and closing during save.
