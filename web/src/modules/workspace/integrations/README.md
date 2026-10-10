# Integrations page

AXA-318 adds Workspace → Integrations (`/integrations`), with keyboard-accessible Connected and Browse tabs. Connected lists configured Slack and existing Zapier connections; Browse provides Slack setup. Workspace administrators can save or replace a Slack incoming webhook in the shared Drawer. Members and viewers can read configuration.

## API and merge dependencies

This branch uses the Sales/Marketing extraction from [frontend PR #475](https://github.com/Tunaxa/tunaxa-crm/pull/475). Merge that prerequisite first to keep this PR's diff focused.

Configuration depends on [backend PR #469](https://github.com/Tunaxa/tunaxa-crm/pull/469), inspected at commit `f1dbb8d57390b2cd2ae15bcfb719fd6410392642`. Its owner must merge its backend prerequisites as well. No backend implementation or schema changes are included here. Before that API is deployed, this page reports unavailability and disables configuration; it does not claim that Slack is connected.

- `GET /api/integrations` returns `{ slack: { configured, webhookUrlMasked }, zapier: { configured, webhookUrlMasked } }`.
- `PUT /api/integrations/slack` receives `{ slackWebhookUrl }` and returns the same masked configuration. Administrator roles match the backend: `admin`, `Owner`, `owner`.
- `integrations.updated` refreshes configuration through the existing SSE/resource refresh mechanism. Window focus and explicit Retry also reload it.

The password input starts blank, accepts HTTPS incoming webhook URLs for Slack and GovSlack, and clears on close/success. See [Slack's incoming webhook documentation](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks). Raw URLs stay in form memory only until submitted to the authenticated backend; they are never put into frontend persistent storage, toast text or displayed server error text. Response parsing retains only the two masked channel fields and rejects unexpectedly unmasked data.

The save acknowledgement must mark Slack configured and match the submitted origin and final six characters. This confirms the backend's masked acknowledgement; it cannot establish full credential equality or successful Slack delivery. Cards therefore say **Configured**, with an explicit delivery status explanation. Writes are not retried for network/server errors; the existing API helper can replay a request after successful authentication refresh. The page reloads configuration after each save attempt and prevents duplicate submissions/stale loads.

No delivery test or disconnect action is included: the backend test endpoint sends probes to all configured channels, and clearing a workspace override can expose a deployment environment fallback instead of disconnecting it. Zapier configuration is outside this task; existing masked Zapier configuration is displayed.

## Validation

- 46 committed tests cover valid/invalid webhook inputs, masked acknowledgement, error redaction, permissions, connected/empty/loading/error/stale states and setup markup.
- Full repository lint and frontend TypeScript checks pass.
- Three additional local contract checks exercise the exact pending #469 route and service with the current server: save/read/replace, member read/write enforcement, and unauthenticated access. Only import paths were adjusted in Git-excluded verification files; outbound fetch was replaced with a failing spy and no outbound calls occurred.
- Full suite: 1,019 tests passed across 70 files against a separate local PostgreSQL database and test JSON store, with the temporary native Vitest loader to avoid this environment's esbuild process restriction. These are local checks, not GitHub CI results.
- Production build is locally blocked by esbuild `spawn EPERM`; browser interaction and actual Slack delivery remain unverified.

## Acceptance after prerequisites merge

1. Open Workspace → Integrations. Check both tabs by mouse and Arrow Left/Right, Home and End keys; verify loading/errors and Retry when the API is unavailable.
2. As an administrator, select Browse → Connect Slack. Paste a workspace incoming webhook URL from Slack and save. Confirm Connected shows Configured and only a masked URL; reload the page and check persistence.
3. Replace the webhook, confirming the input starts blank and both saving/cancel guards work. Verify malformed URLs remain in the drawer with a useful error.
4. Sign in as a member/viewer; confirm configuration is visible and setup controls are absent. Check API write permission enforcement separately.
5. Check narrow screens, dark mode, drawer focus/escape behavior and SSE refresh after another administrator changes configuration.
6. With an approved test Slack channel and the backend deployed, verify a supported deal-won transition delivers the expected notification. Saving configuration alone does not test delivery.
