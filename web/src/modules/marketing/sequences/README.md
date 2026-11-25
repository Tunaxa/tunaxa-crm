# Sequence UI

The hardened Sequence Builder provides an ordered email cadence editor at `/sequences` and a contact enrollment picker on contact record pages. It is restacked on `origin/dev` and preserves every merged module and record feature.

## Contracts

- `GET /api/sequences` and `POST /api/sequences`
- `GET /api/sequences/:id`, `PUT /api/sequences/:id` and `DELETE /api/sequences/:id`
- `GET /api/sequences/:id/enrollments?page=N&limit=50`
- `POST /api/sequences/:id/enroll` with `{ contactIds: [contactId] }`

Reads are workspace-scoped. The dedicated `GET /api/sequences/:id` route returns `404` for IDs outside the caller's workspace, so the UI never depends on the generic resource fall-through. Enrollment responses are confirmed against `{ enrolled, skipped, enrollments }`, with statuses `active`, `paused`, `replied`, `completed` and `stopped`. Active or paused duplicates are blocked before and after the request.

Saves send `{ name, enabled, steps }` plus the original `exitRules` when editing. Email steps keep stable IDs, order, subject, body, recipient override and numeric `delayDays`, `delayHours` and `delayMinutes`. Non-email legacy steps and extra fields are sanitized and preserved unchanged. Subject, body, delay, name and step-count bounds are enforced before submission.

## Access control and module visibility

Write and enroll actions use `canManageRecords(role)`, matching backend `requireRole('admin','member')` for `admin`, `owner`, `Owner` and `member`. Viewers keep read-only access. `/sequences` is registered in both `MODULE_CATALOG` and backend `MODULES` with `minRole: 'viewer'`, so `/api/modules`, the sidebar and `ModuleGate` agree.

## Safety and style

Step sources are copied into null-prototype objects with own-property checks and `sanitizeFieldKey`; `__proto__`, `constructor`, `prototype`, dotted and bracketed keys are dropped. Template tokens such as `{{firstName}}`, `{{name}}` and `{{email}}` are rendered as text and resolved by the backend merge helpers. Step reorder controls are keyboard accessible with explicit aria-labels, API failures use inline `role="alert"`, pending work uses `role="status"`, and styles use canonical `html.dark` tokens with a `768px` breakpoint.
