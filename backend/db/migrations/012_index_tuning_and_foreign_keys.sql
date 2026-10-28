-- Migration 012: index tuning and foreign key coverage
--
-- Three jobs, in order of how much they matter to the app:
--
--   1. Index the relational pointer columns that earlier migrations created
--      without an index. Migrations 004/005/006 add a *_id column per pointer
--      and no index for it, so any join or "records for this parent" lookup
--      degrades to a sequential scan as the table grows.
--   2. Add composite indexes matching the sort order the API actually emits, so
--      a paginated listing can walk the index in order instead of sorting the
--      whole tenant's rows and then discarding all but 50.
--   3. Add expression (functional) indexes for the case-insensitive lookups the
--      repositories issue, which a plain btree on the raw column cannot serve.
--
-- Every statement is IF NOT EXISTS, matching 004-011, so re-running the
-- migration is a no-op.
--
-- ============================================
-- Why there is no ALTER TABLE ... ADD FOREIGN KEY here
-- ============================================
--
-- The task this migration answers asked for "every foreign key column indexed".
-- In this schema the vast majority of *_id columns carry no FOREIGN KEY
-- constraint, and that is deliberate, not an oversight:
--
--   * Migrations 004, 005 and 006 document the choice at length. The legacy
--     JSON store keys records with prefixed strings (deal_..., company_...,
--     contact_...) that a UUID foreign key would reject outright, and
--     migrations 001-003 define no users/companies/contacts/deals tables to
--     reference in the first place.
--   * Adding the constraints now would need a multi-step backfill (populate
--     every legacy id, then validate) and could reject rows the app already
--     accepts. That is a data-integrity migration, not an index migration.
--
-- So this migration treats "*_id column" as the audit unit and indexes those,
-- which is what actually speeds the app up. The declared constraints that do
-- exist - the three from migration 001, all pointing at crm_objects(id) - are
-- listed under section 1 for completeness and were already indexed.
--
-- ============================================
-- Deviations from the requested index list, and why
-- ============================================
--
-- Eight requested columns do not exist in this schema. Requesting them would
-- abort the migration with 42703 undefined_column, so each is replaced with
-- the column this schema actually uses for the same job. All were confirmed
-- against information_schema.columns on a migrated database:
--
--   Requested                     Actually used here
--   ---------------------------   ------------------------------------------
--   contacts.name                 contacts.first_name, contacts.last_name
--   deals.stage_id                deals.stage (TEXT, no stage table)
--   leads.company_id              leads.company_name (free text)
--   leads.contact_id              (no contact pointer on a lead)
--   activities.date               activities.created_at (date lives in
--                                 custom_fields; see migration 005)
--   tickets.contact_id            tickets.contact (free text) +
--                                 tickets.contact_email
--   tickets.company_id            (no company pointer on a ticket)
--   tickets.assigned_to           (tickets are unassigned; the board is per
--                                 stage, see routes/tickets.js)
--   expenses.contact_id           (no contact pointer on an expense)
--
-- The tickets board in routes/tickets.js filters on `stage`
-- (New / In Progress / Awaiting Client / Resolved) and slaStatus() branches on
-- it; `status` is a nullable legacy leftover that the SLA logic ignores. The
-- triage index therefore leads with `stage`, not `status`.

BEGIN;

-- ============================================
-- 1. Relational pointer columns with no index
-- ============================================
-- Verified against pg_indexes before this migration: each index below was
-- absent, so these were sequential scans.
--
-- Already indexed and deliberately not repeated here:
--   deals(company_id)          idx_deals_company_id
--   deals(contact_id)          idx_deals_contact_id
--   activities(deal_id)        idx_activities_deal_id
--   tasks(deal_id)             idx_tasks_deal_id
--   tasks(assigned_to)         idx_tasks_assigned_to
--   quotes(deal_id/company_id/contact_id)
--                               idx_quotes_deal / _company / _contact
--   contracts(quote_id/deal_id/company_id)
--                               idx_contracts_quote / _deal / _company
--   goals(assigned_to)         idx_goals_assigned_to
--   saved_reports(workspace_id) idx_saved_reports_workspace
--   workflow_runs(workflow_id) idx_workflow_runs_workflow
--   invoices(order_id/deal_id) idx_invoices_order / _deal
--   orders(deal_id/quote_id/contract_id)
--                               idx_orders_deal / _quote / _contract
--   expenses(deal_id/company_id) idx_expenses_deal / _company
--   Declared FKs from migration 001:
--     external_id_mappings(object_id)  idx_extid_object
--     object_associations(from_object_id) idx_assoc_from (leading column)
--     object_associations(to_object_id)   idx_assoc_to  (leading column)
-- ============================================

CREATE INDEX IF NOT EXISTS idx_deals_owner_id ON deals (owner_id);
CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts (company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_owner_id ON contacts (owner_id);
CREATE INDEX IF NOT EXISTS idx_leads_owner_id ON leads (owner_id);
CREATE INDEX IF NOT EXISTS idx_activities_contact_id ON activities (contact_id);
CREATE INDEX IF NOT EXISTS idx_activities_user_id ON activities (user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_contact_id ON tasks (contact_id);
CREATE INDEX IF NOT EXISTS idx_contracts_contact_id ON contracts (contact_id);
CREATE INDEX IF NOT EXISTS idx_orders_company_id ON orders (company_id);
CREATE INDEX IF NOT EXISTS idx_orders_contact_id ON orders (contact_id);
CREATE INDEX IF NOT EXISTS idx_invoices_company_id ON invoices (company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_contact_id ON invoices (contact_id);

-- ============================================
-- 2. Composite indexes for tenant listing and sorting
-- ============================================
-- Each of these replaces "filter by tenant, sort the whole tenant, take 50"
-- with "walk the index, stop after 50". Every one leads with workspace_id so
-- the tenant filter and the sort key come from a single index range.

-- repositories/contacts.js findAll() defaults to ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_contacts_ws_created ON contacts (workspace_id, created_at DESC);

-- Pipeline board: filter by stage, newest first.
CREATE INDEX IF NOT EXISTS idx_deals_ws_stage_created ON deals (workspace_id, stage, created_at DESC);

-- Owner/rep view: my deals, newest first.
CREATE INDEX IF NOT EXISTS idx_deals_ws_owner_created ON deals (workspace_id, owner_id, created_at DESC);

-- Covering index for the dashboard revenue/pipeline aggregate
-- (getPipelineSummary in repositories/deals.js, and the dated variant in
-- services/reports.js). INCLUDE (value) lets the aggregate read SUM(value)
-- straight from the index without a heap fetch per row.
CREATE INDEX IF NOT EXISTS idx_deals_ws_created_stage ON deals (workspace_id, created_at, stage) INCLUDE (value);

-- Lead list filtered by lifecycle status, newest first.
CREATE INDEX IF NOT EXISTS idx_leads_ws_status_created ON leads (workspace_id, status, created_at DESC);

-- Activity timeline for one record. Ordered by created_at DESC because
-- activities has no `date` column - migration 005 keeps the legacy `date` in
-- custom_fields, where it cannot be indexed as a column.
CREATE INDEX IF NOT EXISTS idx_activities_ws_record_date ON activities (workspace_id, record_id, created_at DESC);

-- Pending work for one assignee, soonest due first.
CREATE INDEX IF NOT EXISTS idx_tasks_ws_assigned_status ON tasks (workspace_id, assigned_to, status, due_date ASC);

-- Ticket triage board, ordered by priority then newest. Leads with `stage`
-- because that is the column routes/tickets.js filters and sorts on.
CREATE INDEX IF NOT EXISTS idx_tickets_ws_status_priority ON tickets (workspace_id, stage, priority, created_at DESC);

-- Quotes attached to a deal, newest first.
CREATE INDEX IF NOT EXISTS idx_quotes_ws_deal ON quotes (workspace_id, deal_id, created_at DESC);

-- ============================================
-- 2b. Partial indexes for the two boards that filter and sort
--     on different columns
-- ============================================
-- Both indexes above are the right shape for a board that filters on a column
-- and then sorts by the column after it. The two highest-traffic boards do not
-- work that way. With only the indexes above, the benchmark in
-- db/tools/verify-indexes.js showed the planner falling back to
-- idx_tasks_workspace / idx_tickets_workspace and sorting ~10k rows per
-- request, which is how the 10ms target got missed on two of the ten patterns:
--
--   * The open-task board filters completed = false - repositories/tasks.js
--     findAll() pushes `completed = $n` straight into the WHERE clause - and
--     orders by due_date. An index of (workspace_id, assigned_to, status,
--     due_date) cannot supply that order, because the app does not filter on
--     `status` at all: `status` is the legacy vocabulary and `completed` is the
--     normalized boolean. The third column therefore sat between the filter and
--     the sort, so the assignee's rows had to be sorted on every request.
--   * The unresolved-ticket board filters resolved_at IS NULL and orders by
--     priority, but idx_tickets_ws_status_priority leads its ordering with
--     `stage`, which this query never constrains - so again no index order, and
--     again a sort.
--
-- A partial index fixes both: the filter moves into the index predicate, which
-- frees the remaining columns to carry the sort order. It is also smaller,
-- since completed and resolved rows never enter it. The predicate has to match
-- the query's exactly, otherwise the planner will not use the index.

-- WHERE completed = FALSE matches findAll({ completed: false }).
CREATE INDEX IF NOT EXISTS idx_tasks_open_assigned_due
  ON tasks (workspace_id, assigned_to, due_date ASC)
  WHERE completed = FALSE;

-- WHERE resolved_at IS NULL is "not yet resolved" in routes/tickets.js, where
-- slaStatus() reads a null resolved_at as still open.
CREATE INDEX IF NOT EXISTS idx_tickets_open_priority
  ON tickets (workspace_id, priority DESC, created_at DESC)
  WHERE resolved_at IS NULL;

-- ============================================
-- 3. Expression indexes for case-insensitive lookups
-- ============================================
-- repositories/leads.js findByEmail() and repositories/contacts.js
-- findByEmail() compare with LOWER(...) on both sides, and the code comments
-- there call out that the plain btree on email cannot serve the lookup. These
-- are the indexes that comment asks for.
--
-- The searches themselves (findAll({ q })) are substring ILIKE '%term%', which
-- no btree can serve - that wants pg_trgm. This migration does not add it:
-- varchar_pattern_ops below at least lets the planner use the index for
-- anchored prefix matching, and adding an extension is a deployment decision
-- rather than a tuning one. See the notes in db-indexes.test.js.

CREATE INDEX IF NOT EXISTS idx_contacts_ws_lower_email ON contacts (workspace_id, LOWER(email));

-- No contacts.name column exists; first_name/last_name are the searchable
-- pair in repositories/contacts.js. varchar_pattern_ops is required for LIKE
-- to use a btree and is locale-safe for the >=/<= range form.
CREATE INDEX IF NOT EXISTS idx_contacts_ws_lower_name ON contacts (workspace_id, LOWER(first_name) varchar_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_contacts_ws_lower_last_name ON contacts (workspace_id, LOWER(last_name) varchar_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_leads_ws_lower_email ON leads (workspace_id, LOWER(email));

COMMIT;
