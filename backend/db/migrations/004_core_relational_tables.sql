-- Migration 004: Core relational tables for Tunaxa CRM
-- Workspace-scoped entities with foreign keys, cascading rules, and auto-update triggers.
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
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    domain TEXT,
    industry TEXT,
    size TEXT,
    custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    first_name TEXT,
    last_name TEXT,
    email TEXT,
    phone TEXT,
    title TEXT,
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    first_name TEXT,
    last_name TEXT,
    email TEXT,
    phone TEXT,
    company_name TEXT,
    status VARCHAR(255),
    source TEXT,
    value NUMERIC(12, 2),
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    value NUMERIC(12, 2),
    stage VARCHAR(255) NOT NULL,
    expected_close_date DATE,
    custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
    deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    due_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
    deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
    type VARCHAR(50) NOT NULL,
    subject TEXT,
    body TEXT,
    direction VARCHAR(20),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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