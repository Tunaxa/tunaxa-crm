-- Migration 004: Core relational tables for Tunaxa CRM
-- Legacy CRM entities use TEXT ids and pointers, matching 004_contacts_leads
-- and 005_core_entities. Workspaces/users/sessions retain their UUID relations.
-- CREATE TABLE IF NOT EXISTS must use the complete shared definitions: a later
-- migration cannot add missing columns by repeating CREATE TABLE IF NOT EXISTS.
-- Idempotent: safe to re-run (IF NOT EXISTS, OR REPLACE, DROP IF EXISTS).

BEGIN;

-- ============================================
-- 1. Reusable updated_at trigger function
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 2. Core tables
-- ============================================

CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    role VARCHAR(50) NOT NULL DEFAULT 'user',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  company_id TEXT,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  title TEXT,
  owner_id TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  company_name TEXT,
  status VARCHAR(50),
  source VARCHAR(100),
  value DOUBLE PRECISION,
  owner_id TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

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

-- ============================================
-- 3. updated_at triggers
-- ============================================

DROP TRIGGER IF EXISTS set_updated_at ON workspaces;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON workspaces
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON users;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON sessions;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON sessions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON companies;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON companies
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON contacts;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON contacts
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON leads;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON leads
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON deals;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON deals
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON tasks;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON tasks
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON activities;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON activities
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 4. Foreign key indexes
-- ============================================

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_companies_workspace_id ON companies (workspace_id);

CREATE INDEX IF NOT EXISTS idx_contacts_workspace_id ON contacts (workspace_id);
CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts (company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_owner_id ON contacts (owner_id);

CREATE INDEX IF NOT EXISTS idx_leads_workspace_id ON leads (workspace_id);
CREATE INDEX IF NOT EXISTS idx_leads_owner_id ON leads (owner_id);

CREATE INDEX IF NOT EXISTS idx_deals_workspace_id ON deals (workspace_id);
CREATE INDEX IF NOT EXISTS idx_deals_contact_id ON deals (contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_company_id ON deals (company_id);
CREATE INDEX IF NOT EXISTS idx_deals_owner_id ON deals (owner_id);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON tasks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks (assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_contact_id ON tasks (contact_id);
CREATE INDEX IF NOT EXISTS idx_tasks_deal_id ON tasks (deal_id);

CREATE INDEX IF NOT EXISTS idx_activities_workspace_id ON activities (workspace_id);
CREATE INDEX IF NOT EXISTS idx_activities_user_id ON activities (user_id);
CREATE INDEX IF NOT EXISTS idx_activities_contact_id ON activities (contact_id);
CREATE INDEX IF NOT EXISTS idx_activities_deal_id ON activities (deal_id);

COMMIT;