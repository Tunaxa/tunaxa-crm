-- Migration 004: contacts and leads tables
--
-- These back backend/db/repositories/contacts.js and leads.js, which the
-- /api/contacts and /api/leads routes reach through the PG branch of
-- backend/routes/resources.js. Migrations 001-003 create the generic
-- crm_objects/property_definitions model but no contacts or leads table,
-- so those routes had nothing to query.
--
-- Two column types below are forced by the existing API/test contract in
-- backend/__tests__/crud.test.js, not chosen for preference:
--
--   id is TEXT, not UUID.
--     PUT/DELETE /api/leads/lead_nonexistent must answer 404. A UUID column
--     raises 22P02 "invalid input syntax for type uuid" for a non-UUID path
--     segment, which would surface as a 500 instead. TEXT keeps arbitrary
--     legacy string keys addressable while new rows still default to a
--     generated UUID string.
--
--   value is DOUBLE PRECISION, not NUMERIC.
--     node-postgres parses NUMERIC into a JS string by default, and the
--     contract asserts a JSON number: expect(res.body.value).toBe(5000).
--
-- owner_id and company_id are plain TEXT with no foreign key. The legacy
-- JSON store keys records with prefixed strings, and migrations 001-003
-- define no users or companies table to reference.

BEGIN;

-- ============================================
-- contacts
-- ============================================

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

CREATE INDEX IF NOT EXISTS idx_contacts_workspace ON contacts (workspace_id);
-- findAll() defaults to ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts (email);

-- ============================================
-- leads
-- ============================================

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

CREATE INDEX IF NOT EXISTS idx_leads_workspace ON leads (workspace_id);
-- findAll() defaults to ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads (email);

-- ============================================
-- 3. Updated_at triggers
-- Reuses update_updated_at_column() from migration 001, so 001 must be
-- applied first. CREATE OR REPLACE TRIGGER requires PostgreSQL 14+, the same
-- baseline migration 001 already assumes.
-- ============================================

CREATE OR REPLACE TRIGGER trg_contacts_updated
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_leads_updated
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
