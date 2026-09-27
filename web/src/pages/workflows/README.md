# Workflow canvas entry (AXA-117)

Open Canvas on `/workflows` opens a picker, not a canvas. The picker reuses the
workflow list request and displays Name, Status and Last Run. Selecting a record
navigates to `/workflows/:id`, which has Canvas and History views. Returning to
`/workflows?picker=1` reopens the picker.

Existing endpoints: `GET /api/workflows` returns an array; detail uses
`GET /api/workflows/:id`. Last Run displays optional `lastRunAt` if supplied by
the backend; it is unavailable when not supplied. Creation/enablement timestamps
are not substitutes for a run timestamp.

AXA-117 reuses the existing React Flow dependency and custom node palette. Blank
workflows show a blank canvas with controls and minimap. Legacy workflow
event/filter/actions are previewed using the existing conversion. Local node
movement, creation, deletion and connections are enabled for admins/members;
viewers have a read-only canvas. Tabs preserve local canvas edits while staying
on the same detail page. Local canvas changes are not saved by this task.

Follow-up AXA-123 should use `GET /api/workflowbuilder/:id` and
`PUT /api/workflowbuilder/:id` for persisted nodes/edges, save status, and leave
protection. Persisted graph loading is not implemented by AXA-117; the existing
legacy preview must not be saved over a stored graph before loading is wired.

Follow-up AXA-125 should populate History from this workflow's workflow_runs log
and show per-node outcomes. No workflow_runs API is present in current dev.
History explicitly shows integration pending, rather than claiming there are no
runs. The backend owner needs to provide list/detail endpoints and payloads.

New tasks must start from origin/dev after prerequisite work is merged.
