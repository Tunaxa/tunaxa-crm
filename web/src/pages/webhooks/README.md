# Webhook endpoint management

The /webhooks page now separates outgoing endpoint subscriptions from existing
inbound triggers. The original inbound page and editor remain available in the
Inbound triggers section. Outgoing endpoints display URL, subscribed event names
and confirmed Active/Paused state. Admin/member/Owner roles can create and
pause/activate subscriptions; viewer controls remain read-only.

## Existing API contracts used

- GET /api/v1/webhooks returns `{ data, total }` for the full subscription list.
- POST /api/v1/webhooks accepts `{ url, events: string[] }` and returns the new
  subscription plus a one-time `secret`.
- PATCH /api/v1/webhooks/:id accepts `{ is_active: boolean }` and returns the
  updated subscription. The UI requires a matching ID and the requested status
  before acknowledging success, then reloads the list.

Creation accepts HTTP(S) URLs without embedded credentials and deduplicates
comma/newline-separated events. Invalid responses, permissions, loading errors
and an empty confirmed list are distinct. Requests are aborted on unmount and
stale list results cannot overwrite a newer load. Submission guards prevent
concurrent writes. Uncertain creation errors explicitly ask the user to inspect
the refreshed list before retrying because creation has no idempotency contract.

The returned HMAC secret is held only in the mounted creation window. It is
masked by default, can be revealed or copied, and is not saved to browser
storage. Clipboard failure offers manual copying. Closing before copying asks
for confirmation. A successful creation without a returned secret is reported
as created with an unavailable secret, rather than inviting duplicate creation.

## Remaining backend requirements

The current API does not expose existing secrets, per-endpoint delivery logs,
resending failed deliveries or rotating a signing secret. These remain pending
BE-37 contracts. The details section explains the unavailable features; Rotate
Secret and Resend Failed are disabled and do not issue speculative requests.

GET /api/v1/webhooks/events is a global event log, not a per-subscription delivery
history. It cannot safely supply endpoint-specific logs, so this page does not
misattribute its results. The inbound /api/webhookEndpoints/:id/deliveries route
records incoming requests and likewise must not be used as outgoing history.

The user has no BE-37 PR/payload information. This implements only the supported
scope; the complete webhook management task must remain In Progress until those
contracts and integrations are available.

## Verification

Fresh origin/dev base: 5319955. Branch: feat/webhook-endpoint-management. No
production backend files, migrations or dependencies changed. Frontend checks:
104 tests across 16 files, including 33 focused webhook model/rendering tests;
TypeScript, full ESLint and the production build passed. Tests use the existing
Git-excluded native TypeScript Vitest loader. The build reports the existing
large-bundle warning.

Browser interaction, live PostgreSQL/API integration and actual webhook delivery
remain unverified. No webhook was sent and no shared database was modified.

Manual acceptance: confirm outgoing URLs/events/statuses, create an authorized
test subscription, save its secret, exercise clipboard failure/manual copy,
pause and activate it, refresh and verify status persistence. Check viewer
permissions, failed fetch/retry, uncertain create recovery, narrow-screen layout
and that the inbound trigger editor still works. Add real delivery-log, resend
and rotation acceptance checks when BE-37 is supplied.
