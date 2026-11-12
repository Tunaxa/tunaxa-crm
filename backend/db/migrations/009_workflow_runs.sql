-- Migration 009: workflow execution runs history
--
-- Tracks execution runs and per-step node results for visual node graphs
-- and legacy workflows with workspace tenant isolation.

BEGIN;

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  workflow_id TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'running',
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_message TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace ON workflow_runs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_created_at ON workflow_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf_created ON workflow_runs(workflow_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_workflow_runs_updated ON workflow_runs;
CREATE TRIGGER trg_workflow_runs_updated
  BEFORE UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
