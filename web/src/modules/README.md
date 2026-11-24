# Sales and Marketing modules

This directory contains the frontend-only extraction of the active Sales and
Marketing pages from `App.tsx`. Route URLs and backend resource names remain
compatible with the existing API.

| Area | Routes | Module |
| --- | --- | --- |
| Sales | `/leads`, `/contacts`, `/companies`, `/pipeline` | `sales/` |
| Marketing | `/campaigns`, `/marketing-emails`, `/email-lists`, `/forms` | `marketing/` |

Shared record primitives live in `components/records/`. They reuse the existing
Drawer, PageHeader, Empty, Badge and ColumnPicker UI primitives and add explicit
loading, error and retry states. Field definitions live beside each module.

The port preserves the current `dev` behavior: server-side pagination/search,
persistent column preferences, schema-provided custom fields with hidden/masked
field filtering, CSV import/export with safe headers and values, company cards,
bulk selection, deal drag/drop with keyboard fallback, forms pagination and
public URL copying.

`moduleVisibility.ts` applies `/api/modules` visibility to catalog routes and
navigation items. Unlisted legacy marketing routes remain available. When the
API is unavailable, a role-rank fallback is used. Detail deep links are checked
against their base module path so `#/leads/:id` cannot bypass a hidden module.

`modulePages.test.tsx` and `components/records/recordsSafety.test.ts` cover
module visibility, deep-link normalization, safe URLs, CSV/form-key
sanitization, schema filtering, keyboard activation, RBAC and Pipeline move
failures.
