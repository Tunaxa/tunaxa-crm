ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(100) DEFAULT 'default';
UPDATE webhook_events SET workspace_id = 'default' WHERE workspace_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_events_workspace_created ON webhook_events (workspace_id, created_at DESC);
