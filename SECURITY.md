# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately rather than opening a public issue:

- **Email:** security@tunaxa.com
- **GitHub:** use "Report a vulnerability" under the repository's Security tab, which
  opens a private security advisory.

Please include the affected endpoint or file, reproduction steps, and the impact you
observed. We aim to acknowledge within **48 hours** and to keep you updated until a fix
lands. Please do not run automated scanners, send high-volume traffic, or access data
that is not yours while investigating.

Findings in the categories below are the ones we consider most valuable to us: anything
that crosses a tenant boundary, compromises authentication, or executes code on the
server.

## Supported versions

Security fixes land on the default branch. There is no long-term-support branch.

| Version | Supported |
| --- | --- |
| `main` / current default branch | Yes |
| Any tagged release older than the default branch | No |
| Self-hosted deployments pinned to an older commit | No — upgrade to pick up fixes |

Because fixes are not backported, running an old commit means running with the
vulnerabilities present in that commit. Treat upgrading as a security task, not only a
release task.

## How authentication works

Sessions are **opaque random 32-byte tokens**, not JWTs. There is no signing secret to
rotate or leak, and revoking a session means deleting a row.

- Passwords are hashed with `scrypt` and a per-user random salt, and verified with
  `timingSafeEqual`.
- The token is returned to the browser, stored in `localStorage`, and replayed as
  `Authorization: Bearer <token>`.
- Refresh rotates the session: the presented token is invalidated in the same
  transaction that issues its replacement, so a stolen refresh token is usable at most
  once and replay is detectable.

Because the browser attaches no ambient credential, this app is **not classically
CSRF-vulnerable** through the `Authorization` header. An origin check is still enforced
as defence in depth, described under A05 below.

## Tenant isolation

Every tenant-scoped record carries a `workspace_id`. Isolation is enforced in SQL, in
the repository layer, not by filtering results after the fact.

- `findAll`, `findById`, `update` and delete accept an optional `workspaceId`. When it
  is supplied the query is constrained to
  `workspace_id = $n OR ($n = 'default' AND workspace_id IS NULL)`, so pre-migration
  rows with a `NULL` workspace still belong to the `default` tenant.
- The tenant is **server-derived** on every write, from
  `req.user.workspaceId || req.user?.workspace_id || "default"`. A `workspace_id` in a
  request body is ignored on both create and update.
- Reads and writes across a tenant boundary return `404`, not `403`, so a response does
  not confirm that an id exists somewhere.

Omitting `workspaceId` still works and returns unscoped rows. That is deliberate — it
keeps the repositories usable by migrations, backfills, tests and system workers — but
it means **a new call site that forgets the argument silently disables isolation.** The
security suite in `backend/__tests__/security-audit.test.js` asserts isolation
end-to-end for all 19 tenant-scoped resources precisely because this is the easiest
mistake to make in this codebase.

## Rate limits

| Scope | Limit | Window |
| --- | --- | --- |
| Login and first-run setup | 10 requests | 15 minutes |
| Token refresh | 30 requests | 1 minute |
| All of `/api` | 120 requests | 1 minute |
| Public/embeddable endpoints | per-endpoint limiters | — |

A limited response is `429` with a `Retry-After` header. Login and refresh use separate
buckets so that refresh traffic cannot be used to lock a user out of logging in.

`RATE_LIMIT_GLOBAL_MAX` overrides the global ceiling. The bucket is per-process, so a
deployment fronted by several instances may need to raise it; a stricter-than-default
value would otherwise throttle users unevenly across instances.

## OWASP Top 10 (2021) audit

Status refers to the manual review and the automated regression suite in
`backend/__tests__/security-audit.test.js`.

| ID | Category | Status | Notes |
| --- | --- | --- | --- |
| A01 | Broken Access Control | **Fixed** | The generic CRUD route applied no tenant filter at all, and the dedicated `forms`, `tickets` and `goals` routes bypassed scoping entirely. All are now server-scoped. See below. |
| A02 | Cryptographic Failures | Reviewed | scrypt password hashing with per-user salt; `timingSafeEqual` for token and HMAC comparison; opaque session tokens with no signing secret. |
| A03 | Injection | Reviewed | All SQL is parameterised. Dynamic identifiers (report `groupBy`/`metric`/`field`, sort columns, update fields) are validated against per-entity allowlists. |
| A04 | Insecure Design | Reviewed | Rate limits, role checks, and the tenant model above. `default` is the only implicit fallback tenant. |
| A05 | Security Misconfiguration | **Fixed** | Added origin/Referer enforcement for state-changing requests, and removed a production misconfiguration that trusted dev origins. |
| A06 | Vulnerable Components | Reviewed | `npm audit --omit=dev` reports 0 vulnerabilities. |
| A07 | Identification & Auth Failures | **Fixed** | Tightened credential-endpoint limits and separated the refresh bucket. Session rotation on refresh landed in the parent branch. |
| A08 | Software & Data Integrity Failures | Reviewed | Inbound webhook payloads are verified with HMAC and `timingSafeEqual` (Twilio, quote signing, queued webhooks). |
| A09 | Logging & Monitoring Failures | Reviewed | Mutations and auth events are written to the audit log. |
| A10 | Server-Side Request Forgery | Reviewed | Outbound requests only target administrator-configured endpoints (Ollama base URL, Twilio, mail server). There is no endpoint that fetches an arbitrary caller-supplied URL. |

### A01 — what was actually broken

Four independent defects, all reachable by any authenticated user:

1. **`backend/routes/resources.js`** — the generic `/api/:resource` list, read, update
   and delete paths passed no tenant to the repository, so any authenticated user could
   read, modify or delete any other tenant's records, including through the CSV export.
2. **`backend/routes/forms.js`** — `update`, `findById` and `delete` were called with no
   workspace, and `GET /api/forms` listed every tenant's forms.
3. **`backend/routes/tickets.js`** — `findById`, `update`, `addComment` and `delete` were
   called with no workspace, and both the ticket board and the SLA summary listed every
   tenant's tickets.
4. **`backend/routes/goals.js`** — the object literal spread `...body` *after* the
   server-derived `workspace_id`, so a request body could restamp the tenant of a new
   goal. The ordering is now the other way round.

`backend/services/savedReports.js` had the same precedence weakness in a dormant form
(`data.workspaceId` won over the explicit argument) and was corrected even though no
current caller forwards a raw body.

Not every route family is partitioned yet. The list of route files with no tenant
scoping whatsoever is under **Accepted risks** below.

### A05 — origin enforcement

`backend/middleware/csrf.js` rejects state-changing requests whose `Origin`/`Referer`
is neither same-origin nor explicitly allowed.

- `GET`, `HEAD` and `OPTIONS` are never blocked.
- A request with neither `Origin` nor `Referer` is allowed: those are non-browser
  clients, and blocking them would break every legitimate integration while stopping
  nothing.
- Same-origin is compared on host **and** scheme where the request scheme is
  determinable, so an `http` page on an `https` deployment's host is rejected.
- Development origins are trusted **only when `NODE_ENV` is not `production`**. This was
  a real misconfiguration: a production build previously accepted
  `http://localhost:5173` as a trusted origin, which would hand an attacker a known-good
  origin to host a forgery page on.
- Configured origins come from `APP_URL` or `CLIENT_URL` (comma-separated). With neither
  set in production, only same-origin is accepted.

Endpoints that are anonymous or intentionally cross-origin are exempt because they are
not CSRF targets and carry no ambient user credential: Twilio callbacks, token-authed
webhook receivers, the tracking pixel, the chat widget, public form embeds and
submissions, public booking pages, emailed quote-signing links, and the customer portal.

## Accepted risks

These are deliberate and reviewed, not oversights.

- **Public form definitions are readable by permalink without authentication.** Required
  for embedded forms to render. A form's *responses* are tenant-scoped.
- **Quote signing is authorised by possession of a signed, expiring token bound to that
  specific quote**, not by a session, so the signing call itself is intentionally not
  tenant-scoped. The token is HMAC-verified with `timingSafeEqual`.
- **Session tokens live in `localStorage`.** Immune to CSRF, but readable by any script
  running on the origin. A CSP would narrow this; `XSS` is therefore treated as
  high-impact (see A03).
- **Several route families are not tenant-partitioned at all.** `knowledgebase`,
  `lists`, `sequences`, `templates`, `scheduler`, `uploads`, `webhookendpoints`,
  `modules`, `audit` and `ai` contain no workspace reference whatsoever and are backed
  by the shared JSON store, which has no `workspace_id` column. Their records are
  therefore visible to every tenant, not merely mis-scoped. This predates the current
  work and was out of scope for it; the 19 core CRM resources are the ones partitioned
  here. It is the highest-value follow-up, and `v1objects` and `workflowbuilder` are the
  two route files outside that set that already reference a workspace.
- **The global rate limiter is in-process**, so limits are per instance. This is noted
  rather than fixed because a shared store is an infrastructure decision.

## Verifying these claims

```bash
# Tenant isolation, origin enforcement, injection resistance, rate limits
npm test -- backend/__tests__/security-audit.test.js

# Repository-level SQL construction
npm test -- backend/db/repositories/__tests__
```

The security suite is written to fail if isolation is removed: reverting a single tenant
argument makes it go red.
