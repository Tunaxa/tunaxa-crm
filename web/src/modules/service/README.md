# Tickets

AXA-295 adds `/tickets` in the Service navigation. The page uses the existing
PageHeader, Badge, Empty, Drawer and RecordForm primitives.

`useTicketBoard` fetches the complete `GET /api/tickets` board without pagination
parameters, creates tickets through `POST /api/tickets`, and moves them through
`PUT /api/tickets/:id`. It refreshes on resource events, window focus and every
30 seconds while the page is visible. Failed refreshes retain the last loaded
board and block writes until a successful refresh.

`ticketBoard` validates the full-board envelope, keeps unknown stage columns,
checks move responses, and calculates SLA clocks. Stored `firstResponseDueAt`
and `slaDueAt` take precedence; older tickets use the workspace SLA targets from
the list response. Missing or invalid inputs show an unavailable deadline. The
UI does not infer priority tiers or claim a target was met without a timestamp.

The backend owns transition timestamps. Existing first-response and resolution
stamps are included in stage updates to preserve them with the older PUT route.
The frontend follows the stage-transition vocabulary documented by backend
PR #465, including Closed when that column is present. No backend code or
migrations are changed by this task.

Review in a browser:

1. Open `/tickets`, create a ticket and refresh the page.
2. Drag it through the board, then repeat a move with the stage selector.
3. Verify the first-response timestamp remains unchanged after later moves.
4. Check overdue clocks, completed targets, resolved tickets and reopening.
5. Search, filter priority and enable Overdue only; verify every visible card.
6. Test a viewer account, failed refresh/retry, keyboard navigation and mobile.

Automated checks cover deadline calculations, API response validation, failed and
unconfirmed moves, stage restrictions, rendered states and the create/move/reload
API flow. They do not replace the browser interaction checks above.
