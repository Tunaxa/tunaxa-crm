-- Migration 001: Initial schema for Tunaxa CRM
-- Based on HubSpot-Style Data Integration Engine architecture

-- (Transaction handled by the migration runner backend/db/migrate.js, which
-- wraps each pending migration plus its schema_migrations record atomically.)

-- ============================================
-- 1. Dynamic Data Model (JSONB-based objects)
-- ============================================

CREATE TABLE IF NOT EXISTS crm_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type VARCHAR(50) NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- GIN index for arbitrary property searching inside JSONB
CREATE INDEX IF NOT EXISTS idx_crm_objects_properties ON crm_objects USING GIN (properties);
-- Composite index for type-based queries with ordering
CREATE INDEX IF NOT EXISTS idx_crm_objects_type_updated ON crm_objects (object_type, updated_at DESC);
-- Partial index for fast type filtering
CREATE INDEX IF NOT EXISTS idx_crm_objects_type ON crm_objects (object_type) WHERE object_type IS NOT NULL;

-- ============================================
-- 2. Dynamic Property Definitions (Metadata)
-- ============================================

CREATE TABLE IF NOT EXISTS property_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type VARCHAR(50) NOT NULL,
  field_name VARCHAR(100) NOT NULL,
  field_type VARCHAR(50) NOT NULL, -- 'string', 'number', 'enum', 'boolean', 'date'
  label VARCHAR(200) NOT NULL,
  required BOOLEAN DEFAULT FALSE,
  options JSONB DEFAULT '[]'::jsonb, -- Enum options: ["Lead", "Subscriber", "Customer"]
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(object_type, field_name)
);

CREATE INDEX IF NOT EXISTS idx_propdef_object ON property_definitions (object_type);

-- ============================================
-- 3. Graph Association Engine
-- ============================================

CREATE TABLE IF NOT EXISTS object_associations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_object_id UUID NOT NULL REFERENCES crm_objects(id) ON DELETE CASCADE,
  to_object_id UUID NOT NULL REFERENCES crm_objects(id) ON DELETE CASCADE,
  association_type VARCHAR(50) NOT NULL,
  label VARCHAR(50) DEFAULT 'primary',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(from_object_id, to_object_id, association_type)
);

CREATE INDEX IF NOT EXISTS idx_assoc_from ON object_associations (from_object_id, association_type);
CREATE INDEX IF NOT EXISTS idx_assoc_to ON object_associations (to_object_id, association_type);

-- ============================================
-- 4. Webhook Event Log (for BullMQ integration)
-- ============================================

CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(100) NOT NULL,
  object_id UUID NOT NULL,
  object_type VARCHAR(50) NOT NULL,
  changed_properties JSONB DEFAULT '[]'::jsonb,
  status VARCHAR(20) DEFAULT 'pending', -- pending, processing, completed, failed
  attempts INT DEFAULT 0,
  max_attempts INT DEFAULT 5,
  next_retry_at TIMESTAMP WITH TIME ZONE,
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_status ON webhook_events (status, next_retry_at) WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_webhook_object ON webhook_events (object_type, object_id);

-- ============================================
-- 5. External ID Mapping (for dedup/sync)
-- ============================================

CREATE TABLE IF NOT EXISTS external_id_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id UUID NOT NULL REFERENCES crm_objects(id) ON DELETE CASCADE,
  external_system VARCHAR(100) NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  synced_by_integration BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(external_system, external_id)
);

CREATE INDEX IF NOT EXISTS idx_extid_object ON external_id_mappings (object_id);
CREATE INDEX IF NOT EXISTS idx_extid_system ON external_id_mappings (external_system, external_id);

-- ============================================
-- 6. Updated_at trigger (auto-update on change)
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_crm_objects_updated
  BEFORE UPDATE ON crm_objects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_propdef_updated
  BEFORE UPDATE ON property_definitions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_webhook_updated
  BEFORE UPDATE ON webhook_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_extid_updated
  BEFORE UPDATE ON external_id_mappings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 7. Seed default property definitions
-- ============================================

INSERT INTO property_definitions (object_type, field_name, field_type, label, required, options) VALUES
-- Contact
('contact', 'name', 'string', 'Contact name', true, '[]'::jsonb),
('contact', 'email', 'string', 'Email', false, '[]'::jsonb),
('contact', 'phone', 'string', 'Phone', false, '[]'::jsonb),
('contact', 'company', 'string', 'Company', false, '[]'::jsonb),
('contact', 'role', 'string', 'Job title', false, '[]'::jsonb),
('contact', 'owner', 'string', 'Owner', false, '[]'::jsonb),
('contact', 'status', 'enum', 'Status', false, '["New","Contacted","Qualified","Customer","Churned"]'::jsonb),
-- Company
('company', 'name', 'string', 'Company name', true, '[]'::jsonb),
('company', 'industry', 'string', 'Industry', false, '[]'::jsonb),
('company', 'website', 'string', 'Website', false, '[]'::jsonb),
('company', 'country', 'string', 'Country', false, '[]'::jsonb),
('company', 'employees', 'number', 'Employees', false, '[]'::jsonb),
('company', 'owner', 'string', 'Owner', false, '[]'::jsonb),
-- Deal
('deal', 'title', 'string', 'Deal name', true, '[]'::jsonb),
('deal', 'value', 'number', 'Value', false, '[]'::jsonb),
('deal', 'stage', 'enum', 'Stage', false, '["proposalsent","negotiation","contractsent","closedwon","closedlost"]'::jsonb),
('deal', 'company', 'string', 'Company', false, '[]'::jsonb),
('deal', 'owner', 'string', 'Owner', false, '[]'::jsonb),
('deal', 'close_date', 'date', 'Close date', false, '[]'::jsonb),
-- Lead
('lead', 'name', 'string', 'Lead name', true, '[]'::jsonb),
('lead', 'company', 'string', 'Company', false, '[]'::jsonb),
('lead', 'email', 'string', 'Email', false, '[]'::jsonb),
('lead', 'phone', 'string', 'Phone', false, '[]'::jsonb),
('lead', 'source', 'string', 'Source', false, '[]'::jsonb),
('lead', 'status', 'enum', 'Status', false, '["New","Contacted","Qualified","Unqualified"]'::jsonb),
('lead', 'owner', 'string', 'Owner', false, '[]'::jsonb),
('lead', 'value', 'number', 'Estimated value', false, '[]'::jsonb),
-- Task
('task', 'title', 'string', 'Task title', true, '[]'::jsonb),
('task', 'status', 'enum', 'Status', false, '["Open","In Progress","Done"]'::jsonb),
('task', 'owner', 'string', 'Owner', false, '[]'::jsonb),
('task', 'due_date', 'date', 'Due date', false, '[]'::jsonb),
('task', 'priority', 'enum', 'Priority', false, '["Low","Medium","High","Urgent"]'::jsonb),
-- Activity
('activity', 'title', 'string', 'Title', true, '[]'::jsonb),
('activity', 'type', 'enum', 'Type', false, '["Call","Email","Meeting","Note","SMS"]'::jsonb),
('activity', 'contact', 'string', 'Contact', false, '[]'::jsonb),
('activity', 'date', 'date', 'Date', false, '[]'::jsonb)
ON CONFLICT (object_type, field_name) DO NOTHING;

-- ============================================
-- 8. Seed default associations
-- ============================================

-- We'll seed a few default association types that are common in CRMs
-- The actual associations are created dynamically, but these define the allowed types
INSERT INTO property_definitions (object_type, field_name, field_type, label, required, options) VALUES
('_association_types', 'contact_to_company', 'string', 'Contact → Company', false, '["primary","billing","decision_maker"]'::jsonb),
('_association_types', 'deal_to_contact', 'string', 'Deal → Contact', false, '["primary","decision_maker","influencer"]'::jsonb),
('_association_types', 'deal_to_company', 'string', 'Deal → Company', false, '["primary"]'::jsonb),
('_association_types', 'task_to_contact', 'string', 'Task → Contact', false, '["primary"]'::jsonb),
('_association_types', 'activity_to_contact', 'string', 'Activity → Contact', false, '["primary"]'::jsonb),
('_association_types', 'activity_to_deal', 'string', 'Activity → Deal', false, '["primary"]'::jsonb)
ON CONFLICT (object_type, field_name) DO NOTHING;
