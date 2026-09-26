-- Migration 007: marketing & service tables
-- (campaigns, email_lists, forms, tickets, surveys, survey_responses)
--
-- Type choices mirror 004_contacts_leads.sql, 005_core_entities.sql and
-- 006_revenue_tables.sql and are forced by the existing API contract, not
-- chosen for preference:
--
--   id is TEXT, not UUID.
--     The /api/:resource routes must answer 404 for a missing record. A UUID
--     column raises 22P02 "invalid input syntax for type uuid" for a non-UUID
--     path segment, which surfaces as a 500 instead. TEXT keeps arbitrary
--     legacy string keys addressable while new rows still default to a
--     generated UUID string. The legacy store keys these records with
--     prefixed strings (campaign_..., form_..., ticket_...) that a UUID
--     default would never produce.
--
--   Monetary and counter columns are DOUBLE PRECISION, not NUMERIC.
--     node-postgres parses NUMERIC into a JS string by default, and the
--     dashboard/finance aggregates assert JSON numbers. The same reasoning
--     applies to campaigns.target/reached/leads, which modules.js sums.
--
--   *_id / *reference columns are plain TEXT with no foreign key, matching
--     004-006. campaigns, forms and tickets carry no relationship columns in
--     the legacy store at all (see below), so nothing here needs an FK.
--
--   All date columns are TIMESTAMP WITH TIME ZONE, not DATE.
--     The legacy store mixes bare dates ('2026-09-10') and full ISO instants on
--     the same fields, and a timestamptz column accepts both. A DATE column
--     would silently drop the time component and shift the value in time zones
--     behind UTC.
--
-- Column names are taken from what the application actually writes, which in
-- several places differs from the intuitive or the UI-facing label:
--
--   campaigns.channel, not `type`.
--     App.tsx campaignFields keys the field `channel`
--     (Email|SMS|Social|Multi-channel). The marketing summary groups on it.
--
--   email_lists.subscribers is INTEGER, not JSONB.
--     helpers.js NUMERIC_BUILT_INS coerces `subscribers` with Number() and
--     App.tsx renders it with type:"number". The store holds a count, not an
--     address list. There is deliberately no separate subscriber_count column:
--     splitting one legacy value across two columns would let them disagree.
--
--   forms.permalink is UNIQUE.
--     routes/forms.js rejects a duplicate permalink and looks forms up by it
--     on the public GET /api/forms/:permalink route, so it is a real
--     uniqueness contract, not decoration.
--
--   tickets.stage, not `status`.
--     routes/tickets.js defines TICKET_STAGES = ['New','In Progress',
--     'Awaiting Client','Resolved'] and slaStatus() branches on ticket.stage
--     to compute SLA breaches. Naming the column `status` would orphan the
--     SLA logic in the overflow bag. `status` is also present as a nullable
--     column because PUT /api/tickets/:id merges the raw request body, so a
--     client key of that name can legitimately exist in the store.
--
--   tickets.contact / contact_email, not contact_id.
--     The create literal stores a free-text contact *name* and a separate
--     contactEmail. There is no contact id anywhere in the ticket record; the
--     only link back is an activities row carrying `ticketId`.
--
--   surveys.name is NOT NULL, not `title`.
--     App.tsx surveyFields marks `name` required and there is no `title` key.
--     Making title NOT NULL would reject every real record. `title` and
--     `description` exist as nullable columns for callers that do set them.
--
--   surveys stores a single `question` string, not a questions array.
--     App.tsx gives surveys one textarea named `question`. `questions` JSONB
--     is included for the multi-question shape the spec anticipated, and the
--     migration script fills whichever the source record carries.
--
--   survey_responses.survey is a survey *name*, not a survey id.
--     App.tsx surveyResponseFields keys the field `survey` as free text and
--     nothing in the app resolves it to a survey id. survey_id is nullable and
--     reserved for a follow-up that introduces real referential integrity.
--
--   forms.submission_count is always 0 in the legacy store.
--     routes/forms.js initializes it but never increments it - the submit
--     handler writes leads/contacts/webVisits and does not touch the parent
--     form. The column exists because the UI reads it; expect it to be 0.
--
-- custom_fields JSONB is the overflow bag for everything written by the two
-- dedicated route modules that has no column here, plus the arbitrary keys
-- PUT /api/forms/:id and PUT /api/tickets/:id write into the store via an
-- unvalidated Object.assign. The alternative - a column per field written
-- anywhere in the app - is unbounded.
--
-- No repository or route is wired to these tables yet. They exist so the
-- marketing/service data has a typed home in Postgres; the routes still read
-- the JSON store until a follow-up migration moves them, exactly as
-- 003/004/005/006 each landed ahead of their route interception.

BEGIN;

-- ============================================
-- campaigns
-- ============================================

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  name TEXT NOT NULL,
  channel VARCHAR(100),
  status VARCHAR(50) DEFAULT 'Draft',
  description TEXT,
  budget DOUBLE PRECISION,
  spend DOUBLE PRECISION,
  -- App.tsx exposes target/reached/leads as numbers and modules.js sums them
  -- into the marketing summary, so they are typed columns, not bag fields.
  target DOUBLE PRECISION,
  reached DOUBLE PRECISION,
  leads DOUBLE PRECISION,
  start_date TIMESTAMP WITH TIME ZONE,
  end_date TIMESTAMP WITH TIME ZONE,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_workspace ON campaigns (workspace_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_created ON campaigns (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns (status);
CREATE INDEX IF NOT EXISTS idx_campaigns_name ON campaigns (name);

DROP TRIGGER IF EXISTS trg_campaigns_updated ON campaigns;
CREATE TRIGGER trg_campaigns_updated
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- email_lists
-- ============================================

CREATE TABLE IF NOT EXISTS email_lists (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  status VARCHAR(50) DEFAULT 'Draft',
  -- A count, not an address list: helpers.js coerces it with Number() and the
  -- UI renders a number input. See the header note.
  subscribers INTEGER DEFAULT 0,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_lists_workspace ON email_lists (workspace_id);
CREATE INDEX IF NOT EXISTS idx_email_lists_created ON email_lists (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_lists_name ON email_lists (name);
CREATE INDEX IF NOT EXISTS idx_email_lists_status ON email_lists (status);

DROP TRIGGER IF EXISTS trg_email_lists_updated ON email_lists;
CREATE TRIGGER trg_email_lists_updated
  BEFORE UPDATE ON email_lists
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- forms
-- ============================================

CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  name TEXT NOT NULL,
  title TEXT,
  description TEXT,
  -- The public route key. routes/forms.js rejects duplicates and looks forms
  -- up by it, so uniqueness here is a contract, not an index hint.
  permalink TEXT,
  submit_to VARCHAR(50) DEFAULT 'lead',
  progressive BOOLEAN DEFAULT TRUE,
  redirect_url TEXT,
  enabled BOOLEAN DEFAULT TRUE,
  fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Always 0 from the legacy store; the submit handler never increments it.
  submission_count INTEGER DEFAULT 0,
  created_by TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_forms_permalink ON forms (permalink);
CREATE INDEX IF NOT EXISTS idx_forms_workspace ON forms (workspace_id);
CREATE INDEX IF NOT EXISTS idx_forms_created ON forms (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_forms_name ON forms (name);
CREATE INDEX IF NOT EXISTS idx_forms_enabled ON forms (enabled);

DROP TRIGGER IF EXISTS trg_forms_updated ON forms;
CREATE TRIGGER trg_forms_updated
  BEFORE UPDATE ON forms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- tickets
-- ============================================

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  subject TEXT NOT NULL,
  description TEXT,
  -- Not `status`: routes/tickets.js slaStatus() branches on stage to compute
  -- SLA breaches. See the header note.
  stage VARCHAR(50) DEFAULT 'New',
  priority VARCHAR(50) DEFAULT 'Normal',
  source VARCHAR(50) DEFAULT 'Email',
  -- Free-text contact name plus a separate email; the legacy record has no
  -- contact id. The only back-link is an activities row with `ticketId`.
  contact TEXT,
  contact_email TEXT,
  comments JSONB NOT NULL DEFAULT '[]'::jsonb,
  first_response_at TIMESTAMP WITH TIME ZONE,
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolved_by TEXT,
  -- Nullable: PUT /api/tickets/:id merges the raw body, so a client may have
  -- written a `status` key that the stage-based SLA logic ignores.
  status VARCHAR(50),
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_workspace ON tickets (workspace_id);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_stage ON tickets (stage);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets (priority);
CREATE INDEX IF NOT EXISTS idx_tickets_contact ON tickets (contact);
CREATE INDEX IF NOT EXISTS idx_tickets_resolved ON tickets (resolved_at);

DROP TRIGGER IF EXISTS trg_tickets_updated ON tickets;
CREATE TRIGGER trg_tickets_updated
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- surveys
-- ============================================

CREATE TABLE IF NOT EXISTS surveys (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  -- App.tsx marks `name` required; `title` is not a key the UI writes.
  name TEXT NOT NULL,
  title TEXT,
  description TEXT,
  type VARCHAR(50),
  question TEXT,
  audience TEXT,
  target_score DOUBLE PRECISION,
  status VARCHAR(50) DEFAULT 'Draft',
  -- The store holds one question string; questions[] covers the multi-question
  -- shape and is filled by the migration script when the source carries it.
  questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_surveys_workspace ON surveys (workspace_id);
CREATE INDEX IF NOT EXISTS idx_surveys_created ON surveys (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_surveys_status ON surveys (status);
CREATE INDEX IF NOT EXISTS idx_surveys_name ON surveys (name);

DROP TRIGGER IF EXISTS trg_surveys_updated ON surveys;
CREATE TRIGGER trg_surveys_updated
  BEFORE UPDATE ON surveys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- survey_responses
-- ============================================

CREATE TABLE IF NOT EXISTS survey_responses (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  -- A survey *name* in the legacy store, not an id. Nullable survey_id is
  -- reserved for a follow-up that introduces real referential integrity.
  survey TEXT,
  survey_id TEXT,
  respondent TEXT,
  respondent_email TEXT,
  score DOUBLE PRECISION,
  comment TEXT,
  responses JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_at TIMESTAMP WITH TIME ZONE,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_survey_responses_workspace ON survey_responses (workspace_id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_created ON survey_responses (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON survey_responses (survey);
CREATE INDEX IF NOT EXISTS idx_survey_responses_survey_id ON survey_responses (survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_submitted ON survey_responses (submitted_at);

DROP TRIGGER IF EXISTS trg_survey_responses_updated ON survey_responses;
CREATE TRIGGER trg_survey_responses_updated
  BEFORE UPDATE ON survey_responses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
