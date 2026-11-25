# Integrations page

Workspace → Integrations (`/integrations`) exposes the workspace’s write-only integration status. The Connected and Browse tabs are keyboard accessible with arrow, Home and End keys. Members and viewers can read status; only `admin`, `Owner` and `owner` roles can configure Slack.

## API contract

- `GET /api/integrations` returns `{ slack: { configured, webhookUrlMasked }, zapier: { configured, webhookUrlMasked } }`.
- `PUT /api/integrations/slack` receives `{ slackWebhookUrl }` and returns the same masked catalog. Webhooks must use HTTPS on `hooks.slack.com` only.
- `DELETE /api/integrations/slack` clears the workspace’s stored webhook and returns the masked catalog.
- `POST /api/integrations/slack/test` validates the saved webhook against Slack and returns a status payload without secrets.
- `integration.updated` refreshes configuration through the existing SSE/resource refresh mechanism. Window focus and explicit Retry also reload it.

State is stored per workspace. Responses contain masked URLs only, and the frontend parser keeps just the two documented fields. Raw webhook input lives only in the drawer’s password field until it is submitted, is cleared on close or success, and is never written to persistent frontend storage or toast text.

Saving confirms the masked acknowledgement but does not establish successful Slack delivery. The Test Connection action performs the explicit check. Disconnect removes the workspace override without exposing environment fallbacks.

## Validation

- Frontend model tests cover role gating, strict webhook validation, masked acknowledgement, disconnect acknowledgement, prototype-pollution rejection and error redaction.
- Frontend UI tests cover loading, empty, connected, stale, error and read-only states plus explicit drawer labelling, busy state, submit lock and status/alert banners.
- Backend contract tests cover authentication, RBAC, strict URL rejection, unsafe-key rejection, tenant isolation, masked reads, disconnect and test flows.
- Module navigation tests verify `/integrations` is admin-only in both `/api/modules` and the frontend catalog.
