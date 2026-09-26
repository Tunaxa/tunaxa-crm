-- Migration 010: goals table
--
-- Performance goals and target tracking with live progress calculations.

BEGIN;

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  name TEXT NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'revenue',
  target NUMERIC NOT NULL DEFAULT 0,
  period VARCHAR(50) NOT NULL DEFAULT 'monthly',
  assigned_to TEXT,
  assigned_type VARCHAR(50) DEFAULT 'user',
  start_date TIMESTAMP WITH TIME ZONE,
  end_date TIMESTAMP WITH TIME ZONE,
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goals_workspace ON goals(workspace_id);
CREATE INDEX IF NOT EXISTS idx_goals_assigned_to ON goals(assigned_to);
CREATE INDEX IF NOT EXISTS idx_goals_type ON goals(type);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);

CREATE OR REPLACE TRIGGER trg_goals_updated
  BEFORE UPDATE ON goals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
