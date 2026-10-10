# Unified inbox

AXA-314 replaces the inline inbox implementation in `App.tsx` with a module at
the existing `/inbox` route. The left pane lists conversations; selecting one
opens its messages and an inline reply form in the right pane. On narrow screens
the panes stack. Shared page, modal, badge and empty-state primitives are reused.

## Existing API contracts

- `GET /api/messages?type=email&page=N&limit=50` returns
  `{ items, total, page, limit, hasMore }`. All pages are loaded before grouping,
  preventing a conversation from silently losing messages at a page boundary.
  Inconsistent or incomplete pages show a retryable error. A 500-page limit
  rejects inboxes exceeding 25,000 messages rather than displaying partial data.
- `POST /api/messages/send` accepts `channel: "Email"`, `to`, `subject`, `body`,
  `contact` and `idempotencyKey`. The editor guards concurrent submissions and
  reuses the key for an unchanged draft retry while that editor remains mounted.
  The backend owns send idempotency and delivery. Saved, Queued, Sent and Failed
  outcomes are displayed distinctly; Saved is not reported as delivered.
- `PATCH /api/messages/:id` with `{ read: true }` marks messages read only after
  the server confirms the update. Failed updates expose a retry action.
- `DELETE /api/messages/:id` requires confirmation and a confirmed API result.
- `GET /api/templates` supplies optional email templates. Template failures do
  not prevent writing a message manually.

Viewer access is read-only. Incoming replies use `replyTo` or `from`, never the
incoming message's receiving address. Unknown counterparts cannot receive a
reply. Message content is rendered as escaped text. Search and All / Unread /
Sent / Tracked filters operate on complete loaded conversations. Refresh, focus,
resource-change events and a visible-page 60-second timer refresh the feed.

## Scope and dependencies

This branch builds on PR #475 (Sales and Marketing extraction); merge that base
first. No dependency, production backend or database migration changes are
included. The API currently provides email messages without a canonical thread
ID. Conversations therefore group by counterpart and normalized subject;
unrelated emails with the same counterpart and subject can be combined. Provider
reply headers and canonical threading require a backend contract.

This page uses the existing email feed. It does not configure IMAP ingestion,
add other channels, or implement the rich composer/attachments from AXA-315.
Drafts are local to the mounted editor and are not persisted after navigation.

## Validation

- 49 focused frontend model and server-rendered UI tests passed.
- 6 API contract tests passed against an isolated verification database. SMTP
  calls were mocked; no external emails were sent.
- Full suite: 1,028 tests across 71 files passed.
- Full ESLint, TypeScript checking and `git diff --check` passed.
- Vitest used a local, Git-excluded native TypeScript loader because this Windows
  environment blocks esbuild subprocess creation. Production build remains
  unverified: its configuration loader fails with `spawn EPERM`.

Browser interaction, responsive visual checks and actual provider delivery remain
manual validation. Automated rendering checks do not replace those checks.

## Manual acceptance

1. Open `/inbox`, select a conversation and verify all messages, including a
   conversation spanning API pages, appear in chronological order.
2. Reply inline and verify the recipient and subject. Check the returned Sent,
   Saved, Queued or Failed state; verify actual delivery separately with an
   authorized email-provider test account.
3. Check rapid repeated submission, unchanged-draft retry and a failed send that
   preserves the draft. Refresh and inspect the conversation before retrying an
   uncertain result.
4. Exercise unread state, failed read-update retry, filters, search, list paging,
   templates, new-message composition and confirmed deletion.
5. Check viewer access, unknown-sender replies, narrow-screen layout and refresh
   while a conversation is selected.
