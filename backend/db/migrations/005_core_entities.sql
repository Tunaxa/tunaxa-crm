-- Migration 005: companies, deals, tasks, and activities tables
--
-- These back backend/db/repositories/{companies,deals,tasks,activities}.js,
-- which the /api/:resource routes reach through the PG branch of
-- backend/routes/resources.js for every resource in PG_RESOURCES.
-- Migration 004 created contacts and leads only, so those four routes still
-- had no table to query.
--
-- Type choices below are forced by the existing API/test contract, not chosen
-- for preference - the same reasoning 004_contacts_leads.sql documents:
--
--   id is TEXT, not UUID.
--     PUT/DELETE /api/deals/deal_nonexistent must answer 404. A UUID column
--     raises 22P02 "invalid input syntax for type uuid" for a non-UUID path
--     segment, which surfaces as a 500 instead. TEXT keeps arbitrary legacy
--     string keys addressable while new rows still default to a generated
--     UUID string.
--
--   companies.employees and deals.value are DOUBLE PRECISION, not NUMERIC.
--     node-postgres parses NUMERIC into a JS string by default, and the
--     contract asserts JSON numbers: expect(res.body.value).toBe(12345.5).
--
--   *_id columns are plain TEXT with no foreign key, matching 004. Migrations
--     001-003 define no users/companies/deals tables to reference, and the
--     legacy JSON store keys records with prefixed strings that a UUID foreign
--     key would reject. The same reasoning applies to workspace_id.
--
-- custom_fields JSONB is not decoration: it is the overflow bag for the legacy
-- camelCase fields that have no column here (activity `date`, `callId`,
-- `messageId`, `workflowId`, company/task/deal custom fields, ...). See
-- backend/db/legacy-shape.js, which merges the bag back into the flat legacy
-- response so those fields survive the round trip. The alternative - a column
-- per field written anywhere in the app - is unbounded.

BEGIN;

-- ============================================
-- companies
-- ============================================

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  name TEXT NOT NULL,
  domain TEXT,
  industry TEXT,
  website TEXT,
  country TEXT,
  size TEXT,
  employees DOUBLE PRECISION,
  owner TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_companies_workspace ON companies (workspace_id);
-- findAll() defaults to ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_companies_created ON companies (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies (name);
CREATE INDEX IF NOT EXISTS idx_companies_industry ON companies (industry);

-- ============================================
-- deals
-- ============================================

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  -- `title` is the deal name. The shape adapter also accepts a legacy `name`
  -- on write and re-exposes it on read; see legacy-shape.js DEAL_ALIASES.
  title TEXT NOT NULL,
  -- company/contact/owner are the denormalized display names the app already
  -- stores on a deal (routes/ai.js, routes/dashboard.js and routes/reports.js
  -- all read them). The *_id columns are the relational pointers.
  company TEXT,
  company_id TEXT,
  contact TEXT,
  contact_id TEXT,
  pipeline_id TEXT,
  owner TEXT,
  owner_id TEXT,
  value DOUBLE PRECISION,
  stage TEXT,
  expected_close_date TIMESTAMP WITH TIME ZONE,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deals_workspace ON deals (workspace_id);
-- findAll() defaults to ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_deals_created ON deals (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals (stage);
CREATE INDEX IF NOT EXISTS idx_deals_value ON deals (value);
CREATE INDEX IF NOT EXISTS idx_deals_pipeline_id ON deals (pipeline_id);
CREATE INDEX IF NOT EXISTS idx_deals_company_id ON deals (company_id);
CREATE INDEX IF NOT EXISTS idx_deals_contact_id ON deals (contact_id);

-- ============================================
-- tasks
-- ============================================

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  title TEXT NOT NULL,
  description TEXT,
  -- status is the legacy workflow vocabulary ('Open', 'Completed', ...);
  -- completed is the normalized boolean the task contract names.
  status VARCHAR(50) DEFAULT 'Open',
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  priority VARCHAR(50),
  owner TEXT,
  assigned_to TEXT,
  due_date TIMESTAMP WITH TIME ZONE,
  source TEXT,
  contact_id TEXT,
  deal_id TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks (workspace_id);
-- findAll() defaults to ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
-- routes/dashboard.js sorts open tasks by due date.
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks (due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks (assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_deal_id ON tasks (deal_id);

-- ============================================
-- activities
-- ============================================

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  type VARCHAR(50),
  -- title and contact are the two fields the timeline UI and the
  -- ?contact=/?type= filters in backend/routes/resources.js depend on, so they
  -- are queryable columns rather than bag entries.
  title TEXT,
  subject TEXT,
  description TEXT,
  contact TEXT,
  company TEXT,
  direction VARCHAR(20),
  record_id TEXT,
  -- entity_type/entity_id are the generic pointer the task contract names;
  -- record_id is the legacy name for the same thing.
  entity_type TEXT,
  entity_id TEXT,
  user_id TEXT,
  contact_id TEXT,
  deal_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activities_workspace ON activities (workspace_id);
-- findAll() defaults to ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_activities_created ON activities (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_type ON activities (type);
CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities (contact);
CREATE INDEX IF NOT EXISTS idx_activities_record_id ON activities (record_id);
CREATE INDEX IF NOT EXISTS idx_activities_entity ON activities (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activities_deal_id ON activities (deal_id);

-- ============================================
-- Updated_at triggers
-- Reuses update_updated_at_column() from migration 001, so 001 must be
-- applied first. CREATE OR REPLACE TRIGGER requires PostgreSQL 14+, the same
-- baseline migration 001 already assumes.
-- ============================================

CREATE OR REPLACE TRIGGER trg_companies_updated
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_deals_updated
  BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_tasks_updated
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_activities_updated
  BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
