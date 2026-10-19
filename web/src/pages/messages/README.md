# Email composer drawer

The Inbox Compose and Reply actions open a drawer anchored at the bottom-right.
On narrow screens it becomes a full-width bottom drawer. Entry animation respects
reduced motion. The existing Drawer supplies focus trapping and Escape handling.

To accepts one email address and offers native contact autocomplete using
GET /api/contacts?q=...&page=1&limit=20 after a short debounce. Superseded searches
are aborted; contact API failure does not prevent typing an address manually.
GET /api/templates supplies email templates. Template failures offer retry;
applying a template over edited message text requires confirmation.

The Body editor supports Bold, Italic and HTTP(S) links. Formatting applies to
selected body text only. Paste is plain text and dropping HTML is prevented.
Template bodies are inserted as text rather than executed as HTML. The editor
uses the browser's editing commands and reports an unavailable formatting command.

Send calls POST /api/messages/send with channel, to, subject, plain-text body,
optional html, contact and a per-draft idempotencyKey. An unchanged draft retry
keeps its key while mounted. Duplicate clicks are guarded. Sent, Saved and
Queued are reported separately; Failed/uncertain results preserve the draft.
An uncertain result must be checked in the Inbox before retrying. Drafts are not
persisted across reload or navigation. Closing an edited draft asks before
discarding; the drawer cannot close while submission is pending. Viewer send
controls remain disabled. Reply opens a draft instead of submitting an empty body.

## Narrow backend extension

The user delegated the choice to implement working formatting. MessageSchema
now accepts an optional html string up to 100,000 characters. The send route
serializes it through safeEmailHtml before storing or delivering it, then passes
plain text and sanitized HTML to the existing SMTP service. It does not add a
database migration, change provider settings or alter SMTP transport code.

The serializer emits only b/strong, i/em, p/div/br and a single validated HTTP(S)
href on anchors. Other tags and attributes are dropped; ordinary text and decoded
entities are escaped before emission. No scripts, images, styles or event
handlers are emitted. Old clients without html retain their existing behavior.
Open tracking remains present when enabled. Formatted links are direct safe
links; legacy click-link rewriting is not applied to the new formatted branch.
Accepted idempotency replays remain unchanged, and retrying a failed message as
plain text removes its old HTML.

## Base and merge review

Branch feat/email-composer-upgrade starts at freshly fetched origin/dev 5319955.
No unrelated pending feature branches are included. Existing PRs #481 and #482
remain open and touch related Inbox/composer functionality. Their eventual merge
needs to preserve the new drawer entry points and formatting payload rather than
silently restoring the previous composer. The backend lead should review the
optional HTML contract and restricted serializer as part of this PR.

## Validation

Frontend model/render tests cover recipient validation, contacts, templates,
safe links, statuses and the composer controls. Backend service and route tests
cover sanitization, plain-text compatibility, tracking, size limits, viewer
restrictions, duplicate prevention, Saved/Failed outcomes and plain-text retries.
Route tests use an isolated in-memory store and mocked SMTP; no real emails or
database writes are performed. Tests use the existing Git-excluded native
TypeScript Vitest loader. Final checks passed: 116 frontend and focused backend
tests across 18 files, full ESLint, TypeScript checking, production build and
git diff whitespace checks. The build retains its existing large-bundle warning.

Browser interaction, native autocomplete, text-selection formatting, responsive
layout, live PostgreSQL contact lookup and actual provider delivery remain manual
checks. The full database-backed backend suite was not run for this task.

Manual acceptance: open Compose and Reply, search a contact and select its email,
apply a template, select text and apply bold/italic/link, then use an authorized
test mailbox to verify formatting and plain-text fallback. Check clipboard paste,
invalid links, keyboard/Escape behavior, draft confirmation, failed-send retry,
template/contacts outages, viewer access and mobile/reduced-motion layouts.
