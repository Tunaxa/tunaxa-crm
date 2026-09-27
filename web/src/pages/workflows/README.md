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

Follow-up AXA-125 should populate History from this workflow's workflow_runs log
and show per-node outcomes. No workflow_runs API is present in current dev.
History explicitly shows integration pending, rather than claiming there are no
runs. The backend owner needs to provide list/detail endpoints and payloads.

At the user's request, AXA-123 is a follow-up commit on the AXA-117 branch so both
can be reviewed and merged in one PR. This does not assume the branch is merged.
