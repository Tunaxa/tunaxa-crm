# Notification center and mention input

The notification center replaces the placeholder top-bar bell with a drawer that
shows server-paged notifications, unread counts, All/Unread filters, refresh,
individual and bulk read actions, and distinct loading/error/empty states.
The bell exposes the unread count in its accessible label and keeps a visual
badge hidden from assistive technology.

The center uses the shared `api()` helper and the shared `Drawer` component. It
does not poll: live updates arrive through the existing SSE connection as
`notification.created` and `notification.updated`, are translated into a
`tunaxa:resource-changed` event scoped to `notifications`, and trigger an
abortable reload. Focus also refreshes an open feed.

## Backend contract

- `GET /api/notifications?limit=50&offset=0&unreadOnly=false` returns
  `{ notifications, unreadCount, total }` for the authenticated user and active
  workspace only.
- `PATCH /api/notifications/:id/read` requires owner/admin/member, returns the
  saved notification with `read: true`, and returns 404 for another user's or
  workspace's notification.
- `POST /api/notifications/read-all` requires owner/admin/member, returns
  `{ updated }`, and only mutates the caller's workspace notifications.
- `GET /api/notifications/mentionable?q=` returns workspace-scoped teammate
  suggestions without password fields.

All writes and reads are scoped by both `userId` and `workspaceId`. Prototype
pollution keys are rejected on ids and stripped from parsed payloads. Notification
links are restricted to established internal record routes; external URLs,
protocol-relative URLs, encoded separators, query/hash suffixes, traversal and
unsupported `/ticket/:id` links are not offered as navigation.

`createUserNotification()` in `backend/services/notifications.js` validates the
link, stores the notification in the dedicated `db.userNotifications` collection,
and emits `notification.created` to the target user over SSE. `notification.updated`
is emitted by both read actions. Existing `db.notifications` email queue rows are
unchanged.

## MentionInput

`MentionInput` is a controlled textarea that detects an `@query` at the caret,
debounces and cancels workspace-scoped teammate lookups, supports arrow/Enter/Escape
selection, inserts the backend-compatible `@email` token, and renders unique mention
chips. It uses combobox/listbox ARIA semantics and keeps a stable status region for
lookup feedback.

Ticket-comment integration is not part of this change. Notification text is always
rendered as React text; no HTML is injected.
