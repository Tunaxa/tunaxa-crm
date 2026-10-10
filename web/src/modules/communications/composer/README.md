# Record email composer

AXA-315 implementation for the currently available API, as agreed with the user:
plain-text email and templates. Rich formatting and attachments remain pending
a backend payload contract; this is not the complete original AXA-315 scope.

Contact and lead detail pages expose Send email for users with sending access.
A valid record email is required. The shared drawer opens with that recipient
prefilled; the sender can edit it, choose an email template, enter a subject and
write a message. Sending uses the existing `POST /api/messages/send` contract,
with a mounted-draft idempotency key, through the inbox's shared MailEditor.

The drawer prevents closing during submission and asks before discarding an
edited draft. Errors retain the draft. Sent, Saved (provider not configured) and
Queued outcomes are distinguished. Failed or uncertain outcomes remain errors;
an uncertain result should be checked in the inbox before retrying. Drafts are
not persisted across record navigation or page reload.

After a confirmed submission, the record opens its Emails tab and refreshes
email/activity data. The Emails tab now reads the actual paginated message
response through fetchInbox instead of expecting an unsupported `data` array.
Incoming and outgoing emails are matched using normalized sender/recipient
addresses. The shared complete-feed loader rejects incomplete or changing
pagination rather than showing a partial history.

## Dependencies and remaining work

This branch builds on `feat/unified-inbox`, PR #481; merge that first. No new
packages, production backend changes or database migrations are included.

The current endpoint and SMTP service do not forward HTML or attachments.
Adding frontend fields now would silently lose those contents. Once the backend
defines safe HTML, file upload/reference limits and delivery payloads, complete
the WYSIWYG editor and attachment workflow using that contract.

## Verification

- All 160 frontend tests across 19 files passed, including 10 new composer tests.
- Full ESLint, TypeScript and git diff whitespace checks passed.
- Tests used the existing Git-excluded native TypeScript Vitest loader to avoid
  this Windows environment's blocked esbuild subprocess.
- Production build still fails at configuration loading with `spawn EPERM`.
- Backend tests were not rerun: no production backend files changed. The parent
  inbox task's existing send-contract tests cover the API this module reuses.
- Live browser interaction and real provider delivery remain unverified.

Manual checks: open a contact/lead drawer, edit the recipient, use a template,
send and inspect the refreshed Emails tab. Verify Saved versus actual Sent,
failed-send draft retention, duplicate-submit guards, Escape/backdrop draft
confirmation, viewer permissions and narrow-screen layout. Use an authorized
provider test account for actual delivery verification.
