-- Migration 011: saved_reports table
--
-- Saved report definitions produced by the custom report builder. Each row keeps
-- the aggregation definition (`query`) and the optional weekly email delivery
-- schedule (`schedule`) as jsonb so the shape can grow without a migration per
-- field - see routes/reports.js for the validation that guards the contents.

BEGIN;

CREATE TABLE IF NOT EXISTS saved_reports (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  entity TEXT,
  query JSONB NOT NULL DEFAULT '{}'::jsonb,
  schedule JSONB,
  schedule_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_sent_at TIMESTAMP WITH TIME ZONE,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_reports_workspace ON saved_reports(workspace_id);
CREATE INDEX IF NOT EXISTS idx_saved_reports_schedule_enabled ON saved_reports(schedule_enabled);

CREATE OR REPLACE TRIGGER trg_saved_reports_updated
  BEFORE UPDATE ON saved_reports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
