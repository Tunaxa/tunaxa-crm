# Email template preview

This frontend change adds an Action configuration panel to the existing workflow
canvas. Drag Send Email from the palette, use the keyboard-accessible Add Send
Email button, or click an existing email action to open it. Other action types
do not fetch templates or expose the email selector.

The selector reads the existing GET /api/templates array, filters out SMS
templates, and displays the selected template's subject and body. Merge tags
such as {{name}} and {{ contact.name }} are highlighted using the same token
syntax as the existing workflow renderer. Text and line breaks are preserved.
Template content is escaped text, including any stored HTML; it never executes
markup, follows links or loads remote images.

Loading, empty, unavailable-template and fetch-failure states are separate.
Failed requests can be retried. Old requests are aborted when the panel changes
or unmounts. A missing template reference is retained until the user explicitly
chooses another option. Selection updates the current node's configuration with
templateId, subject and body while preserving other action settings. Clearing
the template reference preserves subject/body content.

The current canvas has no save/load integration on origin/dev. This task does
not introduce it: selections belong to the current canvas session and reset
when that canvas is reloaded. Persistence remains the responsibility of the
workflow canvas save/load task. Selecting a template never sends an email or
changes a template record.

Branch: feat/email-template-preview, based on freshly fetched origin/dev at
5319955. No backend, migration, dependency or unrelated pending-feature changes.
The user supplied no issue ID for this task; PR and Linear copy use its title.

Validation: 20 focused tests; 91 frontend tests across 15 files; full ESLint,
TypeScript checking, production build and git diff whitespace checks passed.
Vitest used the existing Git-excluded native TypeScript loader. Browser
interaction and authenticated live template fetching remain manual checks.

Manual acceptance: open a workflow, add/select Send Email, choose two different
templates and verify subject/body plus repeated and nested merge tags. Check a
non-email action, empty template collection, missing saved template, failed
fetch/retry, keyboard access and narrow-screen layout. Verify that reloading
does not imply a saved configuration in this preview-only canvas.
