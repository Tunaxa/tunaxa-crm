# Sales and Marketing modules

AXA-293 moves the active pages out of App.tsx and uses shared record components
in `components/records`. App.tsx keeps navigation and lazy route loading. Existing
route URLs and resource names remain compatible with the backend.

| Area | Routes | Module |
| --- | --- | --- |
| Sales | `/leads`, `/contacts`, `/companies`, `/pipeline` | `sales/` |
| Marketing | `/campaigns`, `/marketing-emails`, `/email-lists`, `/forms` | `marketing/` |

`RecordDetailPage` remains shared across resources, including contact associations,
inline editing, lifecycle stages, timeline filters, quote invoice generation and
contract signatures. Sales keeps CSV actions, advanced filters, bulk selection,
company cards, and deal drag/drop. Field definitions live in each module.

`RecordForm`, `CrudTablePage` and `SimpleCards` reuse the existing Drawer, PageHeader,
Empty, Badge and other UI primitives. The inactive Sales implementations were
removed after the active pages were moved; they are not used as replacements for
the current Leads/Contacts experience.

The same pass adds explicit loading/error/retry states, includes custom schema
fields in the people editor, and requests all rows before local table/board paging.
Forms uses server pagination, keeps its editor and submission counts, and copies
public URLs using the current site origin.

Review checks:

1. Open each Sales/Marketing route, including a direct link or reload.
2. Create and edit records, including a custom property; check CSV and bulk actions.
3. Open contact details and confirm associations, lifecycle and timeline tabs.
4. Move a deal between stages and reopen it; verify company cards and detail links.
5. Create/edit a form, copy its URL, and page through more than 25 forms.
6. Check loading, failed requests/retry, empty lists, viewer access and mobile layouts.

`modulePages.test.tsx` verifies page/resource wiring, translated titles, preserved
controls and fields, loading/failure states, viewer selection restrictions, campaign
count formatting, full-list requests, forms pagination and the shared editor.
Browser interactions and a production build should also be checked before approval.
