# Notification center and mention input

AXA-317 frontend foundation. The active App header's placeholder bell now opens
a notification drawer with unread count, All/Unread filters, server paging,
refresh, individual read acknowledgement and Mark all read. Loading, failure
and confirmed empty states are distinct. A missing service is not reported as
an empty inbox. Badge counts come from the server-wide unread count, not the
visible page. Cached counts are hidden on failure. A changed signed-in user
remounts the center, clears its state and aborts old loads.

The center refreshes on focus, notification resource-change events and a visible
page's 60-second timer. Read actions wait for valid backend acknowledgements and
reload the feed; they do not optimistically claim persistence. Server text is
escaped. Navigation accepts established local record routes only; external,
encoded and unsupported routes are not opened.

## Verified backend contract and merge status

PR #473 defines:

- `GET /api/notifications?limit=50&offset=N&unreadOnly=true|false` returns
  `{ notifications, unreadCount, total }`.
- `PATCH /api/notifications/:id/read` returns the notification with `read: true`.
- `POST /api/notifications/read-all` returns `{ updated: number }`.

On October 10, PR #473 was merged into `feat/email-open-click-tracking`, not
`dev`. PR #472 remains open and targets `feat/sequence-enrollment-api`. The
backend chain containing these changes must reach dev before this center can
load real data. The current fetched dev has no notification endpoints. The UI
therefore shows an unavailable-service message until those endpoints exist.

This frontend branch builds on the email composer PR #482; merge that base first.
No production backend files, dependencies or database migrations are changed.

## MentionInput and remaining integration

`web/src/components/MentionInput.tsx` is a reusable controlled textarea. It
detects an @query at the caret, debounces and cancels asynchronous suggestions,
supports arrow/Enter/Escape selection, inserts the backend-compatible @email
token and renders unique mention chips below the text. Without a suggestion
source, typing and chips remain available with an explanatory message.

Its optional `searchUsers(query, signal)` callback must return a workspace-scoped
array of `{ id, name, email }`. It must not use the current GET /api/users: that
endpoint returns all users and publicUser omits workspace information, so the
frontend cannot safely filter it. A scoped lookup contract is still required.

The component is intentionally not wired into contact notes: PR #473 processes
mentions in ticket comments only. Ticket-comment integration must wait for the
scoped teammate lookup and the ticket UI to be included in the same frontend
base. The backend stores mention links as `/ticket/:id`; that detail route is
not present in this checkout, so these links are not offered as clickable record
links. Reconcile that route with the ticket UI before enabling navigation.

No notification is fabricated client-side and no direct notification creation
request substitutes for a backend mention trigger. AXA-317's end-to-end criterion
remains pending those dependencies and integration checks.

## Validation and manual checks

- 216 frontend tests across 23 files passed, including 56 new tests for backend
  envelopes, read acknowledgements, link validation, mention token insertion
  and rendered UI states.
- Full ESLint and TypeScript checks passed; no errors or warnings.
- Tests used the existing Git-excluded native TypeScript Vitest loader because
  esbuild process creation is blocked locally.
- Production build still fails during configuration loading with spawn EPERM.
- No backend integration suite or browser interactions were run for this task;
  the notification backend is not in this checkout.

After backend integration: verify the real unread badge, All/Unread paging,
individual and all-read persistence, refresh, unavailable-service errors,
sign-out/user-switch isolation and narrow-screen drawer layout. Wire MentionInput
to the scoped teammate source and ticket comment write, select a teammate,
submit the comment, then sign in as the recipient to confirm exactly one mention
notification. Verify its destination route and workspace isolation separately.
