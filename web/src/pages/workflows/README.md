# Workflow picker and persisted canvas (AXA-117 / AXA-123)

Open Canvas on `/workflows` opens a picker, not a canvas. The picker reuses the
workflow list request and displays Name, Status and Last Run. Selecting a record
navigates to `/workflows/:id`, which has Canvas and History views. Returning to
`/workflows?picker=1` reopens the picker.

Existing endpoints: `GET /api/workflows` returns an array; detail uses
`GET /api/workflowbuilder/:id`. Last Run displays optional `lastRunAt` if supplied by
the backend; it is unavailable when not supplied. Creation/enablement timestamps
are not substitutes for a run timestamp.

AXA-117 reuses the existing React Flow dependency and custom node palette. Blank
graphs show a blank canvas with controls and minimap. Saved nodes and edges are
loaded by AXA-123, including their positions and configuration. Local node
movement, creation, deletion and connections are enabled for admins/members;
viewers have a read-only canvas. Tabs preserve local canvas edits while staying
on the same detail page.

AXA-123 uses `GET /api/workflowbuilder/:id` and `PUT /api/workflowbuilder/:id`.
Save sends only `{ nodes, edges }`, preserving other workflow metadata. Saved /
Unsaved changes / Saving status is shown. Selection and canvas measurements do
not count as edits. Duplicate saves and edits during saving are blocked; failed
saves retain edits. Reloads and navigation warn about unsaved changes. Malformed
graphs show a load error; no silent blank fallback is saved over stored data.
Empty arrays remain empty, including for workflows with legacy actions.

AXA-125 loads History on demand from `GET /api/workflows/:id/runs?page=1&limit=20`.
Current dev includes workflow_runs storage and its PostgreSQL repository.
The workflow route registers the history endpoint with workspace scoping and
pagination validation. Missing endpoints show unavailable, not an empty history. Access matches the API's admin/member restriction.

Response: `{ data, total, page, limit, totalPages }`. Each run includes `id`,
`workflow_id`, `trigger_event`, `status`, `started_at`, `completed_at`,
`error_message` and `steps`. Steps include `nodeId`, `nodeName`, `nodeType`,
`status`, `executedAt`, and `error`. Status values are success, failed, running,
and skipped; unexpected values display Unknown. Missing/malformed steps display
unavailable, rather than a fabricated empty breakdown. The list response already
contains step details, so opening a run makes no second API request. Backend
tenant authorization remains required; frontend also rejects mismatched workflow
references. Raw node outputs are not exposed by this viewer.

At the user's request, AXA-123 and AXA-125 are follow-up commits on the AXA-117
branch so all three can be reviewed and merged in one PR. This does not assume
the branch or the backend history branch is merged.
